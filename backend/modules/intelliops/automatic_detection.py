"""Run the shared detector after a financial transaction has committed."""
import logging
import os

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from shared.schema import capabilities, require_current_schema
from shared.timestamps import utc_now
from modules.payment_processing.service import aware
from .detection import detect, fingerprint
from .models import AuditEvent

logger = logging.getLogger(__name__)


def enabled():
    return os.getenv("INTELLIOPS_AUTOMATIC_DETECTION", "true").lower() == "true"


def limit_waits(db):
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SET LOCAL lock_timeout = '1500ms'"))
        db.execute(text("SET LOCAL statement_timeout = '4s'"))


def run_after_commit(bind, references):
    if not enabled() or not references:
        return
    try:
        with Session(bind) as db, db.begin():
            limit_waits(db)
            require_current_schema(db)
            detect(db, "SYSTEM", transaction_refs=frozenset(references), source="POST_COMMIT")
            identity = fingerprint(sorted(set(references)))
            recorded = db.scalar(select(AuditEvent.id).where(
                AuditEvent.action == "AUTOMATIC_DETECTION_SUCCEEDED", AuditEvent.reference == identity).limit(1))
            if recorded is None:
                db.add(AuditEvent(action="AUTOMATIC_DETECTION_SUCCEEDED", actor="SYSTEM", reference=identity,
                                  details={"source": "POST_COMMIT"}, created_at=utc_now()))
    except Exception as error:
        record_failure(bind, "POST_COMMIT", error)


def record_failure(bind, source, error):
    # Driver exceptions can contain sensitive connection details.
    logger.warning("Automatic detection %s failed (%s); manual scan can recover.", source, type(error).__name__)
    try:
        with Session(bind) as db, db.begin():
            limit_waits(db)
            db.add(AuditEvent(action="AUTOMATIC_DETECTION_FAILED", actor="SYSTEM", reference="DETECTION",
                              details={"source": source, "errorType": type(error).__name__}, created_at=utc_now()))
    except Exception as audit_error:
        logger.warning("Could not record detection failure (%s).", type(audit_error).__name__)


def status(db):
    available = enabled() and capabilities(db)["ready"]
    successful = db.scalar(select(AuditEvent).where(
        AuditEvent.action == "AUTOMATIC_DETECTION_SUCCEEDED").order_by(AuditEvent.id.desc()).limit(1))
    failed = db.scalar(select(AuditEvent).where(
        AuditEvent.action == "AUTOMATIC_DETECTION_FAILED",
        AuditEvent.details["source"].as_string() == "POST_COMMIT").order_by(AuditEvent.id.desc()).limit(1))
    degraded = bool(failed and (successful is None or failed.id > successful.id))
    return {"enabled": enabled(), "mode": "POST_COMMIT",
            "state": "UNAVAILABLE" if not available else "DEGRADED" if degraded else "ENABLED",
            "lastSuccessfulScan": aware(successful.created_at) if successful else None,
            "lastFailure": aware(failed.created_at) if failed else None}
