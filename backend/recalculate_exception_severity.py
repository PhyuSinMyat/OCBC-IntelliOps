"""Preview or apply a one-time severity backfill on the configured PostgreSQL target."""
import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import inspect, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

import models  # Register the domain models on the existing metadata.
from modules.intelliops.detection import DETECTOR_LOCK, fingerprint
from modules.intelliops.models import ExceptionCase
from modules.intelliops.severity_backfill import apply_severity_backfill, plan_severity_backfill
from modules.payment_processing.service import simulation_now
from shared.database import engine

PROTECTED = (
    "transactions", "payment_instructions", "payment_requests", "processing_events",
    "accounts", "ledger_records", "ledger_journals", "ledger_entries", "investigation_records",
    "exception_resolutions", "ledger_posting_remediations", "exceptions",
)


def protected_state(db, *, status_change=False):
    state = {}
    for table in PROTECTED:
        row = "to_jsonb(t)"
        if table == "exceptions":
            row += " - 'status' - 'updated_at'" if status_change else " - 'severity'"
        state[table] = db.execute(text(
            f"SELECT count(*), md5(coalesce(string_agg(value, '' ORDER BY value), '')) "
            f"FROM (SELECT md5(({row})::text) AS value FROM {table} t) records"
        )).one()
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-target")
    parser.add_argument("--confirm-plan")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    url = engine.url
    if engine.dialect.name != "postgresql" or not all((url.host, url.database, url.username)):
        parser.error("an explicit PostgreSQL target is required")
    target = fingerprint([url.host, url.port or 5432, url.database, url.username])
    if args.apply and (args.confirm_target != target or not args.confirm_plan or args.backup is None):
        parser.error("apply requires the verified target, reviewed plan and a new backup path")

    try:
        with Session(engine) as db, db.begin():
            db.execute(text("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE " + ("READ WRITE" if args.apply else "READ ONLY")))
            db.execute(text("SET LOCAL lock_timeout = '5s'"))
            if args.apply:
                db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": DETECTOR_LOCK})
                db.execute(text("LOCK TABLE exceptions IN SHARE ROW EXCLUSIVE MODE"))
            schema = inspect(db.connection())
            required = {*PROTECTED, "exception_case_actions", "audit_events", "detection_rules"}
            if not required.issubset(schema.get_table_names()):
                raise RuntimeError("Configured schema is missing required tables. No migration was run.")
            assessments, blocked = plan_severity_backfill(db, simulation_now())
            plan = [{"caseId": case.id, "before": case.severity, "assessment": assessment}
                    for case, assessment in assessments]
            digest = fingerprint([target, plan, blocked])
            counts = dict.fromkeys(("CRITICAL", "HIGH", "MEDIUM", "LOW"), 0)
            counts.update(Counter(item["assessment"]["severity"] for item in plan))
            print(json.dumps({"target": target, "plan": digest, "cases": len(plan) + len(blocked),
                              "wouldChange": sum(item["before"] != item["assessment"]["severity"] for item in plan),
                              "distribution": counts, "unclassifiable": blocked,
                              "inconclusiveCaseIds": [item["caseId"] for item in plan
                                                       if item["assessment"]["severity"] == "MEDIUM"]},
                             indent=2))
            if blocked:
                raise RuntimeError("Some cases could not be classified. No updates were made.")
            if not args.apply:
                return
            if args.confirm_plan != digest:
                raise RuntimeError("The reviewed plan has changed. Run a fresh preview.")
            protected = protected_state(db)
            with args.backup.open("x", encoding="utf-8") as backup:
                json.dump({"target": target, "plan": digest,
                           "cases": [{"id": item["caseId"], "severity": item["before"]} for item in plan]}, backup, indent=2)
            changed = apply_severity_backfill(db, assessments, datetime.now(timezone.utc), "SEVERITY_BACKFILL")
            actual = dict(db.execute(select(ExceptionCase.id, ExceptionCase.severity)).all())
            if actual != {item["caseId"]: item["assessment"]["severity"] for item in plan} or protected_state(db) != protected:
                raise RuntimeError("Post-update verification failed. The transaction was rolled back.")
        print(f"Committed {changed} severity changes. Verified {len(actual)} cases and protected records.")
    except SQLAlchemyError as error:
        print(f"PostgreSQL operation failed ({type(error).__name__}). No update committed.")
        return 1
    except (RuntimeError, OSError) as error:
        print(error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
