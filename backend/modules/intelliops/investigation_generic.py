"""Evidence-grounded AI investigation for operational and ledger exceptions."""
from datetime import datetime, timezone
from uuid import uuid4

from .investigation_amount import retrieve_amount_evidence
from .investigation_projection import PRIVATE_VALUE, model_evidence
from .investigation_schemas import ACTION_TITLES
from .investigation_validation import validate_monetary_claims
from .service import CaseError, get_case


GENERIC_TYPES = {
    'Payment Processing Failure': ('PAYMENT_PROCESSING_FAILURE', 'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'),
    'PAYMENT_PROCESSING_FAILURE': ('PAYMENT_PROCESSING_FAILURE', 'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'),
    'Unmatched Transaction': ('UNMATCHED_TRANSACTION', 'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'),
    'UNMATCHED_TRANSACTION': ('UNMATCHED_TRANSACTION', 'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'),
    'Invalid Ledger Posting': ('INVALID_LEDGER_POSTING', 'CONFIRMED_INVALID_LEDGER_POSTING', 'REVIEW_INVALID_LEDGER_REMEDIATION'),
    'INVALID_LEDGER_POSTING': ('INVALID_LEDGER_POSTING', 'CONFIRMED_INVALID_LEDGER_POSTING', 'REVIEW_INVALID_LEDGER_REMEDIATION'),
    'Ledger Account Mismatch': ('LEDGER_ACCOUNT_MISMATCH', 'CONFIRMED_LEDGER_ACCOUNT_MISMATCH', 'REVIEW_ACCOUNT_MISMATCH_REMEDIATION'),
    'LEDGER_ACCOUNT_MISMATCH': ('LEDGER_ACCOUNT_MISMATCH', 'CONFIRMED_LEDGER_ACCOUNT_MISMATCH', 'REVIEW_ACCOUNT_MISMATCH_REMEDIATION'),
    'Ledger Currency Mismatch': ('LEDGER_CURRENCY_MISMATCH', 'CONFIRMED_LEDGER_CURRENCY_MISMATCH', 'REVIEW_CURRENCY_MISMATCH_REMEDIATION'),
    'LEDGER_CURRENCY_MISMATCH': ('LEDGER_CURRENCY_MISMATCH', 'CONFIRMED_LEDGER_CURRENCY_MISMATCH', 'REVIEW_CURRENCY_MISMATCH_REMEDIATION'),
    'Processing Timeout': ('PROCESSING_TIMEOUT', 'CONFIRMED_PROCESSING_TIMEOUT', 'REVIEW_PROCESSING_TIMEOUT_RECOVERY'),
    'PROCESSING_TIMEOUT': ('PROCESSING_TIMEOUT', 'CONFIRMED_PROCESSING_TIMEOUT', 'REVIEW_PROCESSING_TIMEOUT_RECOVERY'),
}


def retrieve_generic_evidence(db, case_id):
    case = get_case(db, case_id)
    if case.exception_type not in GENERIC_TYPES:
        raise CaseError('This collector does not support the selected exception type.', 409)
    return retrieve_amount_evidence(db, case_id, allowed_types=set(GENERIC_TYPES))


def investigate_generic(evidence, provider):
    started = datetime.now(timezone.utc).isoformat()
    snapshot = evidence['snapshot']
    kind = snapshot['caseRecord']['exceptionType']
    definition = GENERIC_TYPES.get(kind)
    if not definition:
        raise CaseError('This exception type is not supported by the generic investigation.', 409)
    exception_code, expected_diagnosis, expected_action = definition
    model_input = model_evidence(evidence)
    result, model = provider.analyze(model_input)
    financial = model_input['financial_verification']['classification']
    if result.financial_classification != financial:
        raise CaseError('AI result contradicted verified accounting facts; no diagnosis was accepted.', 502)
    if result.diagnosis_classification != expected_diagnosis or result.recommended_action_code != expected_action:
        raise CaseError('AI conclusion or review recommendation contradicts the detected exception type.', 502)
    validate_monetary_claims(result, model_input)
    allowed = set(evidence['evidence_references'])
    for claim in result.facts + result.hypotheses:
        if not set(claim.evidence_refs) <= allowed:
            raise CaseError('AI result cited unavailable source records; no diagnosis was accepted.', 502)
    cause_refs = set(result.root_cause_evidence_refs)
    if not cause_refs <= allowed or PRIVATE_VALUE.search(result.root_cause_code):
        raise CaseError('AI result contains unavailable citations or simulator labels.', 502)
    operational = {f"event:{row['id']}" for row in model_input['snapshot']['events']
                   if row['eventType'] != 'UNRECOGNIZED_EVENT'}
    operational.update(f"request:{row['id']}" for row in model_input['snapshot']['requests'] if row['integrityValid'])
    if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' and not cause_refs.intersection(operational):
        raise CaseError('A cause hypothesis requires cited operational evidence; no diagnosis was accepted.', 502)
    completed = datetime.now(timezone.utc).isoformat()
    record = getattr(provider, 'record_outcome', None)
    if record:
        record('ACCEPTED')
    return dict(case_id=snapshot['caseRecord']['id'], investigation_id=f'INV-{uuid4()}', run_status='COMPLETED',
        started_at=started, completed_at=completed, evidence_snapshot_at=evidence['retrieved_at'], prototype=False,
        provider='openai', model=model, persistence='BROWSER_SESSION_ONLY', exception_type=exception_code,
        diagnosis_classification=result.diagnosis_classification, root_cause_code=result.root_cause_code,
        root_cause_title=result.root_cause_title, root_cause_explanation=result.root_cause_explanation,
        root_cause_status='MODEL_HYPOTHESIS' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'NOT_ESTABLISHED',
        root_cause_evidence_refs=result.root_cause_evidence_refs,
        evidence_strength='Evidence-cited model hypothesis; human review required.' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'Insufficient causal evidence.',
        unresolved_questions=list(dict.fromkeys(['Source evidence is a snapshot, not execution authority.'] + result.uncertainty)),
        payment_comparison=[snapshot['original']], financial_execution_assessment=dict(classification=financial,
            explanation='Current payment, operational-event and ledger evidence was reconciled by deterministic backend checks.',
            original=evidence['verified_assessment']['original'], duplicate=evidence['verified_assessment']['duplicate']),
        financial_impact=evidence['financial_impact'], investigation_trace=snapshot['events'], supporting_evidence=snapshot,
        recommended_action_code=expected_action, recommended_action=ACTION_TITLES[expected_action],
        recommendation_reason=result.recommendation_reason,
        risk_consideration='Proposal only. Revalidate current evidence and obtain required human review before any operational or financial action.',
        policy_review_required=True, evidence_references=evidence['evidence_references'],
        provider_metadata=getattr(provider, 'last_metadata', {}), review_flags=[],
        validation_notes=['Schema, citations, financial facts and exception-specific action prerequisites checked.',
                          'Semantic citation support and causal reasoning require human evaluation.'],
        llm_analysis=result.model_dump())
