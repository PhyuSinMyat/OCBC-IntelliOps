from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from modules.core_banking.router import get_db
from shared.security import actor, analyst
from .email_delivery import get_mailer
from .inbound_email import get_inbound_mailbox
from .resolution_llm import get_resolution_provider
from .resolution_schemas import AssessmentsOut, CommunicationCreateRequest, CommunicationsOut, InboxSyncOut, PlanGenerateRequest, PlansOut, PolicyAssessmentRequest
from .resolution_workflow import assess_policy, communication_recipient, create_communication, generate_plan, list_assessments, list_communications, list_plans, retry_email, sync_inbound_email
from .service import CaseError


router = APIRouter(prefix="/api/exceptions", tags=["Resolution Workflow"])


def fail(error):
    raise HTTPException(error.status, str(error)) from error


@router.get("/{case_id}/resolution-plans", response_model=PlansOut)
def resolution_plans(case_id: str, investigation_id: str | None = Query(None), db=Depends(get_db), role=Depends(actor)):
    try:
        return {"plans": list_plans(db, case_id, investigation_id)}
    except CaseError as error:
        fail(error)


@router.post("/{case_id}/resolution-plans", response_model=PlansOut)
def create_resolution_plan(case_id: str, request: PlanGenerateRequest, db=Depends(get_db), role=Depends(analyst),
                           provider=Depends(get_resolution_provider)):
    try:
        return {"plans": generate_plan(db, case_id, request.investigation_id, request.expected_version, role, provider)}
    except CaseError as error:
        db.rollback(); fail(error)
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "Another resolution plan version was created. Reload before retrying.") from error


@router.get("/{case_id}/communications", response_model=CommunicationsOut)
def communications(case_id: str, investigation_id: str | None = Query(None), db=Depends(get_db), role=Depends(actor)):
    try:
        items, revision = list_communications(db, case_id, investigation_id)
        return {"communications": items, "contextRevision": revision,
                "recipient": communication_recipient(db, case_id)}
    except CaseError as error:
        fail(error)


@router.post("/{case_id}/communications", response_model=CommunicationsOut)
def record_communication(case_id: str, request: CommunicationCreateRequest, db=Depends(get_db),
                         role=Depends(analyst), mailer=Depends(get_mailer)):
    try:
        items, revision = create_communication(db, case_id, request, role, mailer)
        return {"communications": items, "contextRevision": revision,
                "recipient": communication_recipient(db, case_id)}
    except CaseError as error:
        db.rollback(); fail(error)


@router.post("/{case_id}/communications/sync-inbox", response_model=InboxSyncOut)
def sync_communication_inbox(case_id: str, investigation_id: str = Query(...), db=Depends(get_db),
                             role=Depends(analyst), mailbox=Depends(get_inbound_mailbox)):
    try:
        items, revision, imported, scanned = sync_inbound_email(
            db, case_id, investigation_id, mailbox, role)
        return {"communications": items, "contextRevision": revision,
                "recipient": communication_recipient(db, case_id),
                "importedCount": imported, "scannedCount": scanned}
    except CaseError as error:
        db.rollback(); fail(error)
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "This mailbox reply was already imported. Reload the communication timeline.") from error


@router.post("/{case_id}/communications/{communication_id}/retry-email", response_model=CommunicationsOut)
def retry_communication_email(case_id: str, communication_id: str, db=Depends(get_db),
                              role=Depends(analyst), mailer=Depends(get_mailer)):
    try:
        items, revision = retry_email(db, case_id, communication_id, mailer, role)
        return {"communications": items, "contextRevision": revision,
                "recipient": communication_recipient(db, case_id)}
    except CaseError as error:
        db.rollback(); fail(error)


@router.get("/{case_id}/policy-assessments", response_model=AssessmentsOut)
def policy_assessments(case_id: str, db=Depends(get_db), role=Depends(actor)):
    try:
        return {"assessments": list_assessments(db, case_id)}
    except CaseError as error:
        fail(error)


@router.post("/{case_id}/policy-assessments", response_model=dict)
def create_policy_assessment(case_id: str, request: PolicyAssessmentRequest, db=Depends(get_db), role=Depends(analyst)):
    try:
        return assess_policy(db, case_id, request.plan_id, role)
    except CaseError as error:
        db.rollback(); fail(error)
