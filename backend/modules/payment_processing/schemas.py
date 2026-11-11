from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field, ConfigDict, model_validator

Scenario = Literal["NORMAL", "DUPLICATE", "PROCESSING_FAILURE", "MISSING_LEDGER", "AMOUNT_MISMATCH", "UNMATCHED"]
ExceptionScenario = Literal["MISSING_LEDGER", "AMOUNT_MISMATCH", "DUPLICATE", "PROCESSING_FAILURE"]


class PaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sender_account_ref: str = Field(min_length=1, max_length=50)
    receiver_account_ref: str = Field(min_length=1, max_length=50)
    amount: Decimal = Field(gt=0, max_digits=15, decimal_places=2, allow_inf_nan=False)
    currency: str | None = Field(None, pattern=r"^[A-Z]{3}$")
    idempotency_key: str = Field(min_length=8, max_length=80)


class ScenarioRequest(PaymentRequest):
    scenario_code: Scenario
    duplicate_scenario: Literal['CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS'] | None = None
    run_key: str | None = Field(None, min_length=8, max_length=100)

    @model_validator(mode='after')
    def validate_variant(self):
        if bool(self.duplicate_scenario) != bool(self.run_key) or self.duplicate_scenario and self.scenario_code != 'DUPLICATE':
            raise ValueError('A duplicate variant and run_key must be supplied together with DUPLICATE.')
        return self


class ExceptionBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exception_types: list[ExceptionScenario] = Field(min_length=1, max_length=4)
    count_per_type: int = Field(1, ge=1, le=10)


class PaymentOut(BaseModel):
    id: str
    journalReference: str | None = None
    paymentId: UUID | None = None
    senderId: str | None = None
    receiverId: str | None = None
    sender: dict | None = None
    receiver: dict | None = None
    amountCents: int
    currency: str
    status: Literal["Pending", "Processing", "Completed", "Failed", "Rejected", "Held"]
    createdAt: datetime
    completedAt: datetime | None = None
    failureCode: str | None = None
    failureDescription: str | None = None
    requests: list[dict] = Field(default_factory=list)
    relatedPaymentReferences: list[str] = Field(default_factory=list)
    reconciliationDueAt: datetime | None = None
    originalPaymentId: UUID | None = None


class PaymentPage(BaseModel):
    items: list[PaymentOut]
    total: int
    page: int
    page_size: int


class ScenarioOut(PaymentOut):
    runId: UUID
    payments: list[PaymentOut]
    paymentReferences: list[str]
    requestIds: list[UUID]
    instructionReferences: list[UUID]
    journalReferences: list[str]
    attemptCount: int
    postingCount: int
    timestamp: datetime


class EventOut(BaseModel):
    id: str
    paymentId: str
    eventType: str
    status: str | None
    description: str | None
    errorCode: str | None
    occurredAt: datetime
    requestId: UUID | None = None


class RelatedOut(BaseModel):
    journals: list[dict]
    exceptions: list[dict]
    payments: list[dict] = Field(default_factory=list)
