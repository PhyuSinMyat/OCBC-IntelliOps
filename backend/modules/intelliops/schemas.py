from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class CaseNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str = Field(min_length=1, max_length=2000)


class RemediationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    idempotency_key: str = Field(min_length=8, max_length=100)
    note: str | None = Field(None, max_length=1000)


class CloseCaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(None, max_length=1000)


class CaseActionOut(BaseModel):
    id: int
    actionType: str
    actor: str
    details: dict
    createdAt: datetime


class CaseDetailOut(BaseModel):
    id: str
    transactionId: str
    relatedTransactionId: str | None = None
    exceptionType: str
    severity: str
    status: str
    evidence: dict
    createdAt: datetime
    updatedAt: datetime
    resolvedAt: datetime | None = None
    resolutionSummary: str | None = None
    remediation: dict | None = None
    timeline: list[CaseActionOut]
