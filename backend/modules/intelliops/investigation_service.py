"""Duplicate-only LLM investigation. Source evidence and monetary records are read-only."""
from datetime import datetime, timezone
from uuid import uuid4
from .service import CaseError

CAUSE_TITLES = {
    "CAUSE_NOT_ESTABLISHED": "Underlying cause not established from available evidence.",
    "CUSTOMER_DOUBLE_SUBMISSION": "Customer double submission supported by recorded submission events",
    "IDEMPOTENCY_CONTROL_FAILURE": "Automatic retry and idempotency control failure supported by source events",
    "LEGITIMATE_REPEATED_PAYMENT": "Separate authorized business instructions",
}
CAUSE_EXPLANATIONS = {
    "CAUSE_NOT_ESTABLISHED": "The available source evidence does not establish why the second request was submitted.",
    "CUSTOMER_DOUBLE_SUBMISSION": "Distinct customer submission events identify the same intended payment; ledger checks confirm one posting and a held request.",
    "IDEMPOTENCY_CONTROL_FAILURE": "Correlated system timeout, automatic retry and control-failure events accompany two verified postings. Human review and approval are required before any correction.",
    "LEGITIMATE_REPEATED_PAYMENT": "Explicit authorization events establish independent payment intentions. Similar details do not establish duplicate intent.",
}


def investigate(evidence, provider):
    started = datetime.now(timezone.utc).isoformat()
    model_result, model = provider.analyze(evidence)
    bounds = evidence["verified_assessment"]
    for field in ("diagnosis_classification", "root_cause_code", "financial_classification", "recommended_action_code"):
        if getattr(model_result, field) != bounds[field]:
            raise CaseError("AI result exceeded the supported evidence bounds; no diagnosis was accepted.", 502)
    allowed = set(evidence["evidence_references"])
    facts_refs = set()
    for claim in model_result.facts + model_result.hypotheses:
        if not set(claim.evidence_refs) <= allowed:
            raise CaseError("AI result cited unavailable source records; no diagnosis was accepted.", 502)
    for claim in model_result.facts:
        facts_refs.update(claim.evidence_refs)
    if not set(bounds["required_cause_references"]) <= facts_refs:
        raise CaseError("AI result omitted the required causal source citations; no diagnosis was accepted.", 502)
    snapshot = evidence["snapshot"]
    completed = datetime.now(timezone.utc).isoformat()
    financial = bounds["financial_classification"]
    explanation = {
        "SINGLE_POSTING_CONFIRMED": "One payment-aligned posting is verified; source events record the repeated request held before execution.",
        "DOUBLE_POSTING_CONFIRMED": "Two distinct payment-aligned postings are verified; their intent must be assessed separately.",
        "NO_POSTING_CONFIRMED": "Both source requests are recorded as held before execution within this snapshot.",
        "EXECUTION_OUTCOME_UNKNOWN": "Source or ledger evidence is incomplete or conflicting; no financial-loss amount is asserted.",
    }[financial]
    cause = bounds["root_cause_code"]
    return dict(case_id=snapshot["caseRecord"]["id"], investigation_id=f"INV-{uuid4()}",
        run_status="COMPLETED", started_at=started, completed_at=completed,
        evidence_snapshot_at=evidence["retrieved_at"], prototype=False, provider="openai", model=model,
        persistence="BROWSER_SESSION_ONLY", exception_type="DUPLICATE_TRANSACTION",
        diagnosis_classification=bounds["diagnosis_classification"], root_cause_code=cause,
        root_cause_title=CAUSE_TITLES[cause], root_cause_explanation=CAUSE_EXPLANATIONS[cause],
        evidence_strength="Cause supported by explicit source events" if cause != "CAUSE_NOT_ESTABLISHED" else "Partial supporting evidence",
        unresolved_questions=list(dict.fromkeys(bounds["uncertainty"] + model_result.uncertainty)),
        payment_comparison=[snapshot["original"], snapshot["duplicate"]],
        financial_execution_assessment=dict(classification=financial, explanation=explanation,
                                             original=bounds["original"], duplicate=bounds["duplicate"]),
        investigation_trace=snapshot["events"], supporting_evidence=snapshot,
        recommended_action_code=bounds["recommended_action_code"],
        recommended_action=bounds["recommended_action_code"].replace("_", " ").title(),
        recommendation_reason=model_result.recommendation_reason,
        risk_consideration="Proposal only. Revalidate current evidence and obtain required human review/approval before any corrective action. No action was executed.",
        policy_review_required=True, evidence_references=evidence["evidence_references"],
        llm_analysis=model_result.model_dump())
