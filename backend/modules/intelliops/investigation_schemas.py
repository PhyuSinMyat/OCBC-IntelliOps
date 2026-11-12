"""Strict provider output, separate from source evidence and financial authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

Diagnosis = Literal["CONFIRMED_DUPLICATE_REQUEST", "LEGITIMATE_SEPARATE_INSTRUCTIONS", "SUSPECTED_DUPLICATE", "INSUFFICIENT_EVIDENCE"]
Financial = Literal["SINGLE_POSTING_CONFIRMED", "DOUBLE_POSTING_CONFIRMED", "NO_POSTING_CONFIRMED", "EXECUTION_OUTCOME_UNKNOWN"]
Action = Literal["CLOSE_HELD_DUPLICATE", "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION", "REVIEW_FALSE_POSITIVE_CLOSURE", "ESCALATE_FOR_PAYMENT_VERIFICATION"]


class EvidenceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    statement: str = Field(min_length=1, max_length=1200)
    evidence_refs: list[str] = Field(min_length=1, max_length=30)


class ModelInvestigation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    diagnosis_classification: Diagnosis
    root_cause_code: str = Field(min_length=1, max_length=80, pattern=r'^[A-Z][A-Z0-9_]*$')
    root_cause_title: str = Field(min_length=1, max_length=240)
    root_cause_explanation: str = Field(min_length=1, max_length=2000)
    root_cause_evidence_refs: list[str] = Field(max_length=30)
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
    request_id: str | None = Field(None, min_length=1, max_length=200)
    source_component: Literal['payment_simulator', 'payment_processor', 'payment_gateway', 'core_banking', 'ledger'] | None = None
    retry_of_request_id: str | None = Field(None, min_length=1, max_length=200)
    sender_account_ref: str | None = Field(None, min_length=1, max_length=50)
    receiver_account_ref: str | None = Field(None, min_length=1, max_length=50)
    amount: str | None = Field(None, pattern=r'^\d{1,16}(\.\d{1,2})?$')
    currency: str | None = Field(None, pattern=r'^[A-Z]{3}$')
    lookup_result: Literal['MATCH', 'MISS', 'ERROR'] | None = None
    authoritative_execution_present: bool | None = None
    posting_started: bool | None = None
    matched_payment_ref: str | None = Field(None, min_length=1, max_length=100)
    journal_reference: str | None = Field(None, min_length=1, max_length=100)


class InvestigationEvidenceOut(BaseModel):
    """Additive contract; nested source records retain their existing field names."""
    snapshot: dict
    verified_assessment: dict
    financial_impact: dict
    financial_verification: dict
    verified_assessment_scope: Literal['LEGACY_HEURISTIC_NOT_LLM_INPUT']
    evidence_references: list[str]
    retrieved_at: str
