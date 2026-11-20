"""Preview or apply a controlled case-status reconciliation."""
import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import inspect, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from recalculate_exception_severity import PROTECTED, protected_state
from modules.intelliops.case_status import plan_case_status_reconciliation, reconcile_case_statuses
from modules.intelliops.detection import DETECTOR_LOCK, fingerprint
from modules.intelliops.models import ExceptionCase
from shared.database import engine


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
            required = {*PROTECTED, "exception_case_actions", "audit_events"}
            if not required.issubset(schema.get_table_names()):
                raise RuntimeError("Configured schema is missing required tables. No migration was run.")
            assessments = plan_case_status_reconciliation(db)
            plan = [{"caseId": case.id, "before": case.status, "after": status, "source": source,
                     "reference": reference, "ambiguous": ambiguous}
                    for case, status, source, reference, ambiguous in assessments]
            digest = fingerprint([target, plan])
            print(json.dumps({"target": target, "plan": digest, "cases": len(plan),
                              "wouldChange": sum(item["before"] != item["after"] for item in plan),
                              "before": dict(Counter(item["before"] for item in plan)),
                              "distribution": dict(Counter(item["after"] for item in plan)),
                              "preservedWithoutEvidence": [item["caseId"] for item in plan if item["ambiguous"]]},
                             indent=2))
            if not args.apply:
                return
            if args.confirm_plan != digest:
                raise RuntimeError("The reviewed plan has changed. Run a fresh preview.")
            protected = protected_state(db, status_change=True)
            with args.backup.open("x", encoding="utf-8") as backup:
                json.dump({"target": target, "plan": digest,
                           "cases": [{"id": item["caseId"], "status": item["before"]} for item in plan]}, backup, indent=2)
            changed = reconcile_case_statuses(db, assessments, datetime.now(timezone.utc))
            actual = dict(db.execute(select(ExceptionCase.id, ExceptionCase.status)).all())
            if actual != {item["caseId"]: item["after"] for item in plan} or protected_state(db, status_change=True) != protected:
                raise RuntimeError("Post-update verification failed. The transaction was rolled back.")
        print(f"Committed {changed} status changes. Verified {len(actual)} cases and protected records.")
    except SQLAlchemyError as error:
        print(f"PostgreSQL operation failed ({type(error).__name__}). No update committed.")
        return 1
    except (RuntimeError, OSError) as error:
        print(error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
