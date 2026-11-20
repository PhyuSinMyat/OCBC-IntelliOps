from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class PlanGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    investigation_id: str = Field(min_length=5, max_length=50)
    expected_version: int = Field(ge=0)


class CommunicationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    investigation_id: str = Field(min_length=5, max_length=50)
    customer_id: str = Field(min_length=1, max_length=80)
    related_transaction_id: str | None = Field(None, max_length=100)
    direction: Literal["OUTGOING"]
    communication_type: Literal["INCIDENT_NOTIFICATION", "RESOLUTION_STATUS_UPDATE"]
    subject: str | None = Field(None, max_length=200)
    body: str = Field(min_length=1, max_length=5000)
    recipient_email: str | None = Field(None, max_length=254)
    related_communication_id: str | None = Field(None, max_length=36)
    delivery_mode: Literal["RECORD_ONLY", "EMAIL"] = "RECORD_ONLY"


class PolicyAssessmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: str = Field(min_length=36, max_length=36)


class PlansOut(BaseModel):
    plans: list[dict]


class CommunicationsOut(BaseModel):
    communications: list[dict]
    contextRevision: int
    recipient: dict | None = None


class InboxSyncOut(CommunicationsOut):
    importedCount: int
    scannedCount: int


class AssessmentsOut(BaseModel):
    assessments: list[dict]


class ResolutionStepModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=40, pattern=r"^[a-z][a-z0-9_-]*$")
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=1200)
    evidenceReferences: list[str] = Field(max_length=12)
    requiresHumanReview: Literal[True]


class CustomerCommunicationProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    recommended: bool
    reason: str = Field(min_length=1, max_length=800)
    suggestedMessageType: Literal["Incident notification", "Resolution status update", "Status clarification if required"]


class ApprovalRecommendation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    required: bool
    suggestedRole: Literal["Administrator", "Authorised case reviewer"]
    reason: str = Field(min_length=1, max_length=800)


class ResolutionProposalModel(BaseModel):
    """AI-authored review proposal. Action eligibility remains deterministic."""
    model_config = ConfigDict(extra="forbid", strict=True)
    recommendedActionCode: str = Field(min_length=3, max_length=100, pattern=r"^[A-Z][A-Z0-9_]*$")
    resolutionTitle: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=1600)
    steps: list[ResolutionStepModel] = Field(min_length=1, max_length=8)
    customerCommunication: CustomerCommunicationProposal
    financialConsiderations: list[str] = Field(min_length=1, max_length=8)
    risksAndSafeguards: list[str] = Field(min_length=1, max_length=8)
    approvalRecommendation: ApprovalRecommendation
    uncertainty: list[str] = Field(min_length=1, max_length=8)
