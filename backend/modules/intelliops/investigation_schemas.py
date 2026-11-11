"""Strict provider output, separate from source evidence and financial authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

Diagnosis = Literal["CONFIRMED_DUPLICATE_REQUEST", "LEGITIMATE_SEPARATE_INSTRUCTIONS", "SUSPECTED_DUPLICATE", "INSUFFICIENT_EVIDENCE"]
Cause = Literal["CUSTOMER_DOUBLE_SUBMISSION", "IDEMPOTENCY_CONTROL_FAILURE", "LEGITIMATE_REPEATED_PAYMENT", "CAUSE_NOT_ESTABLISHED"]
Financial = Literal["SINGLE_POSTING_CONFIRMED", "DOUBLE_POSTING_CONFIRMED", "NO_POSTING_CONFIRMED", "EXECUTION_OUTCOME_UNKNOWN"]
Action = Literal["CLOSE_HELD_DUPLICATE", "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION", "REVIEW_FALSE_POSITIVE_CLOSURE", "ESCALATE_FOR_PAYMENT_VERIFICATION"]


class EvidenceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    statement: str = Field(min_length=1, max_length=1200)
    evidence_refs: list[str] = Field(min_length=1, max_length=30)


class ModelInvestigation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    diagnosis_classification: Diagnosis
    root_cause_code: Cause
    financial_classification: Financial
    facts: list[EvidenceClaim] = Field(min_length=1, max_length=12)
    hypotheses: list[EvidenceClaim] = Field(max_length=8)
    uncertainty: list[str] = Field(min_length=1, max_length=12)
    recommended_action_code: Action
    recommendation_reason: str = Field(min_length=1, max_length=1600)


class SourceEventData(BaseModel):
    """Optional typed payload stored in existing ProcessingEvent.details JSON text.

    A missing/malformed payload is unavailable evidence, never a fabricated event.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    origin: Literal["CUSTOMER", "SYSTEM"] | None = None
    trigger: Literal["USER_SUBMIT", "AUTOMATIC_RETRY"] | None = None
    intent_id: str | None = Field(None, min_length=1, max_length=200)
    submission_id: str | None = Field(None, min_length=1, max_length=200)
    authorization_id: str | None = Field(None, min_length=1, max_length=200)
    authorized: bool | None = None
    correlation_id: str | None = Field(None, min_length=1, max_length=200)
    original_payment_ref: str | None = Field(None, min_length=1, max_length=100)
