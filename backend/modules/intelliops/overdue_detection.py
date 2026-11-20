"""Check overdue completed payments without starting a timer in FastAPI."""
from itertools import islice

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from modules.core_banking.models import LedgerJournal, LedgerRecord
from modules.payment_processing.models import PaymentInstruction, Transaction
from modules.payment_processing.service import aware, simulation_now
from shared.schema import require_current_schema
from .automatic_detection import enabled, limit_waits, record_failure
from .detection import DETECTOR_LOCK, detect, due_at
from .models import DetectionObservation
from .rules import load_rules

MISSING = "MISSING_LEDGER_POSTING"


def scan_overdue(bind, now=None):
    if not enabled():
        return []
    now = aware(now or simulation_now())
    try:
        with Session(bind) as db, db.begin():
            limit_waits(db)
            if bind.dialect.name == "postgresql" and not db.scalar(
                    text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": DETECTOR_LOCK}):
                return []
            require_current_schema(db)
            rule, config = load_rules(db, now, read_only=True)[MISSING]
            if not rule.enabled:
                return []
            modern = select(LedgerJournal.journal_id).where(or_(
                LedgerJournal.source_transaction_id == Transaction.id,
                LedgerJournal.payment_reference == Transaction.reference)).exists()
            legacy = select(LedgerRecord.id).where(LedgerRecord.transaction_id == Transaction.id).exists()
            already_observed = select(DetectionObservation.id).where(
                DetectionObservation.transaction_id == Transaction.id,
                DetectionObservation.rule_id == rule.id,
                DetectionObservation.defective.is_(True)).exists()
            candidates = db.execute(select(Transaction, PaymentInstruction)
                .outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)
                .where(Transaction.status == "COMPLETED", Transaction.created_at <= now,
                       ~modern, ~legacy, ~already_observed)
                .order_by(Transaction.created_at, Transaction.id))
            references = frozenset(islice((tx.reference for tx, instruction in candidates
                                           if due_at(tx, instruction, config) <= now), 50))
            if not references:
                return []
            return detect(db, "SYSTEM", now, transaction_refs=references, source="SCHEDULED", only_rules={MISSING})
    except Exception as error:
        record_failure(bind, "SCHEDULED", error)
        raise
