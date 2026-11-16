"""Durable request reservation and immutable accepted reports; no financial writes."""
import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime
from sqlalchemy import String, Integer, ForeignKey, DateTime, JSON, CheckConstraint, Index, event, select
from sqlalchemy.exc import IntegrityError, ProgrammingError, OperationalError
from sqlalchemy.orm import Mapped, mapped_column
from shared.database import Base
from shared.timestamps import utc_now
from .investigation_projection import model_evidence
from .service import CaseError, parse_case_id


class InvestigationRecord(Base):
    __tablename__ = 'investigation_records'
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey('exceptions.id'), nullable=False)
    created_by: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20))
    investigation_id: Mapped[str | None] = mapped_column(String(50), unique=True)
    evidence_fingerprint: Mapped[str] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(100))
    report: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status IN ('RUNNING','ACCEPTED','REJECTED','FAILED','UNKNOWN')", name='ck_investigation_status'),
        CheckConstraint("(status = 'ACCEPTED' AND report IS NOT NULL AND investigation_id IS NOT NULL AND http_status = 200) OR (status <> 'ACCEPTED' AND report IS NULL)", name='ck_investigation_report'),
        Index('ix_investigation_case_created', 'case_id', 'created_at'),
        Index('uq_investigation_running_case', 'case_id', unique=True,
              postgresql_where=status == 'RUNNING', sqlite_where=status == 'RUNNING'),
    )


@event.listens_for(InvestigationRecord, 'before_update')
def immutable_terminal(mapper, connection, target):
    previous = connection.scalar(select(InvestigationRecord.status).where(InvestigationRecord.request_id == target.request_id))
    if previous != 'RUNNING':
        raise ValueError('Historical investigation records are immutable.')


@event.listens_for(InvestigationRecord, 'before_delete')
def immutable_delete(mapper, connection, target):
    raise ValueError('Investigation history cannot be deleted by the application.')


def enabled():
    return os.getenv('INTELLIOPS_INVESTIGATION_PERSISTENCE', 'false').lower() == 'true'


def require_enabled():
    if not enabled():
        raise CaseError('Durable investigation history is not enabled. Deploy the approved SQL and enable INTELLIOPS_INVESTIGATION_PERSISTENCE before using saved history.', 503)


def fingerprint(evidence):
    data = model_evidence(evidence)
    data.pop('retrieved_at', None)
    def canonical(value):
        if isinstance(value, dict): return {k: canonical(v) for k, v in value.items()}
        if isinstance(value, list):
            return sorted((canonical(v) for v in value), key=lambda v: json.dumps(v, sort_keys=True))
        return value
    return hashlib.sha256(json.dumps(canonical(data), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def reserve(db, case_id, request_id, role, evidence):
    require_enabled()
    case = parse_case_id(case_id)
    try:
        record = db.get(InvestigationRecord, str(request_id))
        if record:
            if record.case_id != case:
                raise CaseError('Investigation request ID belongs to a different case.', 409)
            return record, False
        record = InvestigationRecord(request_id=str(request_id), case_id=case, created_by=role,
            status='RUNNING', evidence_fingerprint=fingerprint(evidence))
        db.add(record)
        db.commit()  # Reserve durably BEFORE the external request, across workers/restarts.
        return record, True
    except IntegrityError:
        db.rollback()
        record = db.get(InvestigationRecord, str(request_id))
        if record and record.case_id == case: return record, False
        raise CaseError('An investigation is already reserved for this case. Retrieve history before starting another paid request.', 409)
    except (ProgrammingError, OperationalError):
        db.rollback()
        raise CaseError('Investigation storage is unavailable. Apply only the separately approved SQL deployment; no provider call was made.', 503)


def existing_result(record):
    if record.status == 'ACCEPTED': return 200, deepcopy(record.report)
    if record.status == 'RUNNING':
        return 409, {'detail': 'This investigation is running or its outcome is unknown. Do not create another request ID; retrieve history and review the original request.'}
    return record.http_status or 503, deepcopy(record.error or {'detail': 'Investigation outcome is unavailable; do not retry automatically.'})


def finish(db, record, report=None, error=None, status='FAILED', http_status=502, evidence=None):
    if record.status != 'RUNNING': raise CaseError('Historical investigation cannot be overwritten.', 409)
    if report is not None:
        report = deepcopy(report)
        # Persist only the fact allowlist, never raw detection dictionaries/private metadata.
        snapshot = model_evidence(evidence)['snapshot']
        report.update(persistence='BACKEND_DATABASE', evidence_fingerprint=record.evidence_fingerprint,
                      validation_status='ACCEPTED_WITH_REVIEW_FLAGS' if report.get('review_flags') else 'ACCEPTED')
        report['supporting_evidence'] = snapshot
        report['investigation_trace'] = snapshot['events']
        report['payment_comparison'] = [snapshot['original'], snapshot['duplicate']]
        record.report = report
        record.investigation_id = report['investigation_id']
        record.model = report.get('provider_metadata', {}).get('response_model', report['model'])
        record.status, record.http_status = 'ACCEPTED', 200
    else:
        # Rejected candidates are NOT accepted reports. Persist only a safe failure summary.
        record.error, record.status, record.http_status = error, status, http_status
    record.completed_at = utc_now()
    db.add(record)
    db.commit()
    return existing_result(record)


def history(db, case_id, limit=20, offset=0, investigation_id=None):
    require_enabled()
    query = select(InvestigationRecord).where(InvestigationRecord.case_id == parse_case_id(case_id))
    if investigation_id: query = query.where(InvestigationRecord.investigation_id == investigation_id, InvestigationRecord.status == 'ACCEPTED')
    rows = db.scalars(query.order_by(InvestigationRecord.created_at.desc(), InvestigationRecord.request_id).offset(offset).limit(limit)).all()
    return [dict(request_id=r.request_id, status=r.status, created_at=r.created_at.isoformat(),
                 investigation_id=r.investigation_id, evidence_fingerprint=r.evidence_fingerprint,
                 report=deepcopy(r.report), error=deepcopy(r.error)) for r in rows]


def import_accepted_report(db, saved, role='ADMIN'):
    """Explicit administrative import, locally revalidated; NEVER calls OpenAI."""
    from uuid import uuid5, NAMESPACE_URL
    from .investigation_schemas import ModelInvestigation, AmountMismatchModelInvestigation, MissingLedgerModelInvestigation
    from .investigation_service import investigate
    require_enabled()
    if saved.get('prototype') is not False or saved.get('run_status') != 'COMPLETED':
        raise CaseError('Only an accepted backend report can be imported.', 422)
    financial = saved['financial_execution_assessment']
    evidence = dict(snapshot=saved['supporting_evidence'], financial_impact=saved['financial_impact'],
        evidence_references=saved['evidence_references'], retrieved_at=saved['evidence_snapshot_at'],
        verified_assessment=dict(financial_classification=financial['classification'],
                                 original=financial['original'], duplicate=financial['duplicate']))
    schema = (AmountMismatchModelInvestigation if saved.get('exception_type') == 'AMOUNT_MISMATCH' else
              MissingLedgerModelInvestigation if saved.get('exception_type') == 'MISSING_LEDGER_POSTING' else ModelInvestigation)
    candidate = schema.model_validate(saved['llm_analysis'])
    class SavedAnalysis:
        def analyze(self, data): return candidate, saved['model']
    checked = investigate(evidence, SavedAnalysis())
    if checked['case_id'] != saved['case_id']:
        raise CaseError('Saved report case does not match its evidence snapshot.', 422)
    for field in ('investigation_id', 'started_at', 'completed_at', 'evidence_snapshot_at'):
        checked[field] = saved[field]
    checked['provider_metadata'] = {k: deepcopy(v) for k, v in saved.get('provider_metadata', {}).items()
        if k in {'configured_model', 'response_model', 'response_status', 'http_status', 'max_output_tokens', 'timeout_seconds', 'latency_seconds'}}
    checked['provider_metadata']['usage'] = {k: v for k, v in saved.get('provider_metadata', {}).get('usage', {}).items()
        if k in {'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens'} and type(v) is int}
    previous = db.scalar(select(InvestigationRecord).where(InvestigationRecord.investigation_id == saved['investigation_id']))
    if previous:
        if previous.evidence_fingerprint != fingerprint(evidence) or previous.report['llm_analysis'] != saved['llm_analysis']:
            raise CaseError('A different immutable report already uses this investigation ID.', 409)
        return existing_result(previous)
    request_id = str(uuid5(NAMESPACE_URL, 'intelliops:historical-import:' + saved['investigation_id']))
    record, owner = reserve(db, saved['case_id'], request_id, role, evidence)
    if not owner: return existing_result(record)
    return finish(db, record, report=checked, evidence=evidence)
