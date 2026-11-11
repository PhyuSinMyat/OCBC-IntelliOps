from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from modules.core_banking.router import get_db
from shared.security import actor
from .service import CaseError
from .investigation_evidence import retrieve_evidence
from .investigation_llm import get_investigation_provider
from .investigation_service import investigate

router = APIRouter(prefix="/api/exceptions", tags=["Duplicate Investigation"])


def collect(db, case_id):
    # A fresh transaction is bounded to evidence collection; no database write is made.
    # On PostgreSQL enforce repeatable-read/read-only before the first source query.
    if db.bind.dialect.name == "postgresql":
        db.connection(execution_options={"isolation_level": "REPEATABLE READ", "postgresql_readonly": True})
    evidence = retrieve_evidence(db, case_id)
    evidence["retrieved_at"] = datetime.now(timezone.utc).isoformat()
    db.rollback()  # Release source snapshot/connection before the external LLM call.
    return evidence


@router.get("/{case_id}/investigation-evidence")
def investigation_evidence(case_id: str, db: Session = Depends(get_db), role=Depends(actor)):
    try:
        return collect(db, case_id)
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error


@router.post("/{case_id}/investigations")
def start_investigation(case_id: str, db: Session = Depends(get_db), role=Depends(actor),
                        provider=Depends(get_investigation_provider)):
    try:
        return investigate(collect(db, case_id), provider)
    except CaseError as error:
        raise HTTPException(error.status, str(error)) from error
