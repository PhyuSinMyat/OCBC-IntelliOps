"""Strict provider output, separate from source evidence and financial authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

Diagnosis = Literal["CONFIRMED_DUPLICATE_REQUEST", "LEGITIMATE_SEPARATE_INSTRUCTIONS", "SUSPECTED_DUPLICATE", "INSUFFICIENT_EVIDENCE"]
Financial = Literal["SINGLE_POSTING_CONFIRMED", "DOUBLE_POSTING_CONFIRMED", "NO_POSTING_CONFIRMED", "EXECUTION_OUTCOME_UNKNOWN"]
Action = Literal["CLOSE_HELD_DUPLICATE", "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION", "REVIEW_FALSE_POSITIVE_CLOSURE", "ESCALATE_FOR_PAYMENT_VERIFICATION"]
AmountDiagnosis = Literal["CONFIRMED_AMOUNT_MISMATCH", "NO_AMOUNT_MISMATCH", "INSUFFICIENT_EVIDENCE"]
AmountFinancial = Literal["UNDERPOSTING_CONFIRMED", "OVERPOSTING_CONFIRMED", "AMOUNT_MATCH_CONFIRMED", "EXECUTION_OUTCOME_UNKNOWN"]
AmountAction = Literal["REVIEW_SHORTFALL_ADJUSTMENT", "REVIEW_OVERPOSTING_CORRECTION", "REVIEW_FALSE_POSITIVE_CLOSURE", "ESCALATE_FOR_AMOUNT_VERIFICATION"]
MissingDiagnosis = Literal["CONFIRMED_MISSING_POSTING", "POSTING_RECORD_PRESENT", "INSUFFICIENT_EVIDENCE"]
MissingFinancial = Literal["NO_POSTING_RECORD_CONFIRMED", "POSTING_RECORD_PRESENT", "EXECUTION_OUTCOME_UNKNOWN"]
MissingAction = Literal["REVIEW_MISSING_POSTING_REMEDIATION", "REVIEW_FALSE_POSITIVE_CLOSURE", "ESCALATE_FOR_LEDGER_VERIFICATION"]
ACTION_MEANINGS = {
    'CLOSE_HELD_DUPLICATE': 'Propose human closure review of a confirmed duplicate request: shared instruction, one verified posting and a repeat held before execution. No automatic case closure.',
    'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION': 'Propose human review of confirmed shared-instruction duplicate execution with two verified postings. Two postings alone do not prove an unintended duplicate. No automatic financial correction.',
    'REVIEW_FALSE_POSITIVE_CLOSURE': 'Propose human closure review of an incorrectly flagged pair: independently authorized separate instructions and two verified postings. A genuine duplicate request successfully held is not a false positive.',
    'ESCALATE_FOR_PAYMENT_VERIFICATION': 'Request additional human verification when intent, execution or other evidence remains uncertain. Always available; identify the specific material missing or conflicting evidence requiring review. Unknown customer motivation alone does not negate a verified authorization. No closure or financial change is proposed.',
}
ACTION_INSTRUCTIONS = ' '.join(f'{code}: {meaning}' for code, meaning in ACTION_MEANINGS.items())
ACTION_TITLES = {
    'CLOSE_HELD_DUPLICATE': 'Review held-duplicate closure',
    'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION': 'Escalate duplicate financial execution for review',
    'REVIEW_FALSE_POSITIVE_CLOSURE': 'Review false-positive closure',
    'ESCALATE_FOR_PAYMENT_VERIFICATION': 'Escalate for payment verification',
    'REVIEW_SHORTFALL_ADJUSTMENT': 'Review posting shortfall adjustment',
    'REVIEW_OVERPOSTING_CORRECTION': 'Review excess posting correction',
    'ESCALATE_FOR_AMOUNT_VERIFICATION': 'Escalate for amount verification',
    'REVIEW_MISSING_POSTING_REMEDIATION': 'Review missing-posting remediation',
    'ESCALATE_FOR_LEDGER_VERIFICATION': 'Escalate for ledger verification',
}


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
    recommended_action_code: Action = Field(description='Review-only proposals, never execution authority. ' + ACTION_INSTRUCTIONS)
    recommendation_reason: str = Field(min_length=1, max_length=1600, description='Explain how cited source evidence supports the proposed review action. For verification escalation identify the material unresolved evidence, distinguishing unknown customer motivation from missing or conflicting authorization. Do not merely repeat the diagnosis or action label.')


class AmountMismatchModelInvestigation(BaseModel):
    """Strict model output for one payment reconciled against aligned journals."""
    model_config = ConfigDict(extra="forbid", strict=True)
    diagnosis_classification: AmountDiagnosis
    root_cause_code: str = Field(min_length=1, max_length=80, pattern=r'^[A-Z][A-Z0-9_]*$')
    root_cause_title: str = Field(min_length=1, max_length=240)
    root_cause_explanation: str = Field(min_length=1, max_length=2000)
    root_cause_evidence_refs: list[str] = Field(max_length=30)
    financial_classification: AmountFinancial
    facts: list[EvidenceClaim] = Field(min_length=1, max_length=12)
    hypotheses: list[EvidenceClaim] = Field(max_length=8)
    uncertainty: list[str] = Field(min_length=1, max_length=12)
    recommended_action_code: AmountAction
    recommendation_reason: str = Field(min_length=1, max_length=1600)


class MissingLedgerModelInvestigation(BaseModel):
    """Strict model output for one completed payment checked for ledger evidence."""
    model_config = ConfigDict(extra="forbid", strict=True)
    diagnosis_classification: MissingDiagnosis
    root_cause_code: str = Field(min_length=1, max_length=80, pattern=r'^[A-Z][A-Z0-9_]*$')
    root_cause_title: str = Field(min_length=1, max_length=240)
    root_cause_explanation: str = Field(min_length=1, max_length=2000)
    root_cause_evidence_refs: list[str] = Field(max_length=30)
    financial_classification: MissingFinancial
    facts: list[EvidenceClaim] = Field(min_length=1, max_length=12)
    hypotheses: list[EvidenceClaim] = Field(max_length=8)
    uncertainty: list[str] = Field(min_length=1, max_length=12)
    recommended_action_code: MissingAction
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


class SavedInvestigationOut(BaseModel):
    request_id: str
    status: Literal['RUNNING', 'ACCEPTED', 'REJECTED', 'FAILED', 'UNKNOWN']
    created_at: str
    investigation_id: str | None
    evidence_fingerprint: str
    report: dict | None
    error: dict | None
    stale: bool | None


class InvestigationHistoryOut(BaseModel):
    persistence: Literal['BACKEND_DATABASE']
    investigations: list[SavedInvestigationOut]
    current_evidence_fingerprint: str | None
    current_evidence_availability: Literal['AVAILABLE', 'UNAVAILABLE']
    limit: int
    offset: int
