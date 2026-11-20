from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Header, Query
from uuid import UUID
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from modules.core_banking.router import get_db
from shared.security import actor
from .service import CaseError
from .investigation_evidence import retrieve_evidence
from .investigation_amount import retrieve_amount_evidence
from .investigation_missing import retrieve_missing_evidence
from .investigation_llm import get_investigation_provider
from .investigation_service import investigate
from .investigation_schemas import InvestigationEvidenceOut, InvestigationHistoryOut
from .investigation_runs import once
from . import investigation_storage as storage
from .service import get_case

router = APIRouter(prefix="/api/exceptions", tags=["Duplicate Investigation"])


def collect(db, case_id):
    # A fresh transaction is bounded to evidence collection; no database write is made.
    # On PostgreSQL enforce repeatable-read/read-only before the first source query.
    if db.bind.dialect.name == "postgresql":
        db.connection(execution_options={"isolation_level": "REPEATABLE READ", "postgresql_readonly": True})
    case = get_case(db, case_id)
    evidence = (retrieve_amount_evidence(db, case_id) if case.exception_type in {'Amount Mismatch', 'AMOUNT_MISMATCH'} else
                retrieve_missing_evidence(db, case_id) if case.exception_type in {'Missing Ledger Posting', 'MISSING_LEDGER_POSTING'} else
                retrieve_evidence(db, case_id))
    evidence["retrieved_at"] = datetime.now(timezone.utc).isoformat()
    db.rollback()  # Release source snapshot/connection before the external LLM call.
    return evidence


@router.get("/{case_id}/investigation-evidence", response_model=InvestigationEvidenceOut)
def investigation_evidence(case_id: str, db: Session = Depends(get_db), role=Depends(actor)):
    try:
        return collect(db, case_id)
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error


@router.post("/{case_id}/investigations")
def start_investigation(case_id: str, db: Session = Depends(get_db), role=Depends(actor),
                        provider=Depends(get_investigation_provider),
                        request_id: UUID | None = Header(None, alias='X-Investigation-Request-ID')):
    def execute():
        record = None
        try:
            if storage.enabled() and request_id is None:
                raise CaseError('X-Investigation-Request-ID UUID is required for durable investigation requests.', 422)
            evidence = collect(db, case_id)
            if storage.enabled():
                record, owner = storage.reserve(db, case_id, request_id, role, evidence)
                db.refresh(record)
                db.expunge(record)
                db.rollback()  # No source/storage connection held during the model call.
                if not owner: return storage.existing_result(record)
            report = investigate(evidence, provider)
            return storage.finish(db, record, report=report, evidence=evidence) if record else (200, report)
        except CaseError as error:
            recorder = getattr(provider, 'record_outcome', None)
            if recorder:
                recorder('REJECTED', error)
            body = {'detail': str(error), 'provider_metadata': getattr(provider, 'last_metadata', {})}
            if record is not None and record.status == 'RUNNING':
                return storage.finish(db, record, error=body,
                    status='REJECTED' if getattr(provider, 'last_analysis', None) else 'FAILED', http_status=error.status)
            return error.status, body
        except Exception:
            db.rollback()
            if record is not None and record.status == 'RUNNING':
                try:
                    return storage.finish(db, record, error={'detail': 'Investigation outcome is uncertain. Review the original request before starting another paid investigation.'}, status='UNKNOWN', http_status=503)
                except Exception:
                    db.rollback()
            return 503, {'detail': 'Investigation outcome or storage is unavailable. Do not retry with a new request ID; review saved history.'}
    try:
        status, result = once((role, case_id, str(request_id)), execute) if request_id and not storage.enabled() else execute()
        return JSONResponse(status_code=status, content=result)
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error


def saved_history(db, case_id, limit, offset, investigation_id=None):
    storage.require_enabled()
    get_case(db, case_id)  # Same shared ADMIN/ANALYST case access boundary as evidence GET.
    rows = storage.history(db, case_id, limit, offset, investigation_id)
    db.rollback()
    current, compatible, availability = None, set(), 'AVAILABLE'
    try:
        current, compatible = storage.compatible_fingerprints(collect(db, case_id))
    except Exception:
        db.rollback()
        availability = 'UNAVAILABLE'
    for row in rows:
        row['stale'] = row['evidence_fingerprint'] not in compatible if current else None
    return dict(persistence='BACKEND_DATABASE', investigations=rows, current_evidence_fingerprint=current,
                current_evidence_availability=availability, limit=limit, offset=offset)


@router.get('/{case_id}/investigations', response_model=InvestigationHistoryOut)
def list_investigations(case_id: str, limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0),
                        db: Session = Depends(get_db), role=Depends(actor)):
    try:
        return saved_history(db, case_id, limit, offset)
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error


@router.get('/{case_id}/investigations/{investigation_id}', response_model=InvestigationHistoryOut)
def get_investigation(case_id: str, investigation_id: str, db: Session = Depends(get_db), role=Depends(actor)):
    try:
        result = saved_history(db, case_id, 1, 0, investigation_id)
        if not result['investigations']: raise CaseError('Saved accepted investigation not found for this case.', 404)
        return result
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error
