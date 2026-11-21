from fastapi import APIRouter, Depends, HTTPException
from modules.core_banking.router import get_db
from shared.security import actor, analyst
from .schemas import CaseNoteRequest, RemediationRequest, CloseCaseRequest, CaseDetailOut
from .service import CaseError, add_note, case_detail, close_case, get_case
from .resolution import remediate_exception


router = APIRouter(prefix="/api/exceptions", tags=["IntelliOps Exceptions"])


def handle(error):
    raise HTTPException(error.status, str(error)) from error


@router.get("/{case_id}", response_model=CaseDetailOut)
def exception_detail(case_id: str, db=Depends(get_db), role=Depends(actor)):
    try:
        return case_detail(db, get_case(db, case_id))
    except CaseError as error:
        handle(error)


@router.post("/{case_id}/notes", response_model=CaseDetailOut)
def note(case_id: str, request: CaseNoteRequest, db=Depends(get_db), role=Depends(analyst)):
    try:
        with db.begin():
            case = add_note(db, case_id, request.note, role)
        return case_detail(db, case)
    except CaseError as error:
        handle(error)


@router.post("/{case_id}/remediate", response_model=CaseDetailOut)
def remediate(case_id: str, request: RemediationRequest, db=Depends(get_db), role=Depends(analyst)):
    try:
        with db.begin():
            from shared.schema import require_current_schema
            require_current_schema(db)
            case = remediate_exception(db, case_id, request, role)
        return case_detail(db, case)
    except CaseError as error:
        handle(error)


@router.post("/{case_id}/close", response_model=CaseDetailOut)
def close(case_id: str, request: CloseCaseRequest, db=Depends(get_db), role=Depends(analyst)):
    try:
        with db.begin():
            case = close_case(db, case_id, request.note, role)
        return case_detail(db, case)
    except CaseError as error:
        handle(error)
