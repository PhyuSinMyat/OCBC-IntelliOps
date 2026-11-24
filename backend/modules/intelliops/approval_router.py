from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from modules.core_banking.router import get_db
from shared.security import actor, administrator, analyst
from .approval_workflow import create_request, decide_request, get_request, list_requests
from .resolution_models import ApprovalRequest
from .service import CaseError


router = APIRouter(prefix="/api/approval-requests", tags=["Approval Requests"])


class ApprovalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assessment_id: str = Field(min_length=36, max_length=36)


class ApprovalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["APPROVED", "REJECTED"]
    reason: str = Field(min_length=12, max_length=1000)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value):
        value = value.strip()
        if not any(character.isalpha() for character in value):
            raise ValueError("Decision reason must include an explanation.")
        return value


def fail(error):
    raise HTTPException(error.status, str(error)) from error


@router.get("")
def approvals(status: Literal["PENDING_APPROVAL", "APPROVED", "REJECTED"] | None = Query(None),
              db=Depends(get_db), role=Depends(actor)):
    return {"requests": list_requests(db, status)}


@router.get("/{request_id}")
def approval(request_id: str, db=Depends(get_db), role=Depends(actor)):
    try:
        return get_request(db, request_id)
    except CaseError as error:
        fail(error)


@router.post("")
def submit(request: ApprovalCreate, db=Depends(get_db), role=Depends(analyst)):
    try:
        return create_request(db, request.assessment_id, role)
    except CaseError as error:
        db.rollback(); fail(error)
    except IntegrityError as error:
        db.rollback()
        # A concurrent submission can only win the assessment uniqueness race.
        existing = db.scalar(select(ApprovalRequest).where(ApprovalRequest.assessment_id == request.assessment_id))
        if existing:
            return get_request(db, existing.id)
        raise HTTPException(409, "Another approval request was submitted. Reload the approval queue.") from error


@router.post("/{request_id}/decision")
def decide(request_id: str, request: ApprovalDecision, db=Depends(get_db), role=Depends(administrator)):
    try:
        return decide_request(db, request_id, request.decision, request.reason, role)
    except CaseError as error:
        db.rollback(); fail(error)
