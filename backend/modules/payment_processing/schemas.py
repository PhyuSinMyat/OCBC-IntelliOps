from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field, ConfigDict

Scenario = Literal["NORMAL", "DUPLICATE", "PROCESSING_FAILURE", "MISSING_LEDGER", "AMOUNT_MISMATCH", "UNMATCHED"]


class PaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sender_account_ref: str = Field(min_length=1, max_length=50)
    receiver_account_ref: str = Field(min_length=1, max_length=50)
    amount: Decimal = Field(gt=0, max_digits=15, decimal_places=2, allow_inf_nan=False)
    currency: str | None = Field(None, pattern=r"^[A-Z]{3}$")
    idempotency_key: str = Field(min_length=8, max_length=80)


class ScenarioRequest(PaymentRequest):
    scenario_code: Scenario


class PaymentOut(BaseModel):
    id: str
    paymentId: UUID | None = None
    senderId: str | None = None
    receiverId: str | None = None
    sender: dict | None = None
    receiver: dict | None = None
    amountCents: int
    currency: str
    status: Literal["Pending", "Processing", "Completed", "Failed"]
    createdAt: datetime
    completedAt: datetime | None = None
    failureCode: str | None = None
    failureDescription: str | None = None
    scenarioCode: str | None = None
    reconciliationDueAt: datetime | None = None
    originalPaymentId: UUID | None = None


class PaymentPage(BaseModel):
    items: list[PaymentOut]
    total: int
    page: int
    page_size: int


class EventOut(BaseModel):
    id: str
    paymentId: str
    eventType: str
    status: str | None
    description: str | None
    errorCode: str | None
    occurredAt: datetime


class RelatedOut(BaseModel):
    journals: list[dict]
    exceptions: list[dict]
