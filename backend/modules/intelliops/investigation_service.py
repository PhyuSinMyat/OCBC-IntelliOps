"""Duplicate-only LLM investigation. Source evidence and monetary records are read-only."""
from datetime import datetime, timezone
from uuid import uuid4
from .service import CaseError
from .investigation_projection import model_evidence, PRIVATE_VALUE
from .investigation_validation import validate_monetary_claims, authorization_review_flags
from .investigation_schemas import ACTION_TITLES


def investigate(evidence, provider):
    if evidence.get('snapshot', {}).get('caseRecord', {}).get('exceptionType') in {'Amount Mismatch', 'AMOUNT_MISMATCH'}:
        from .investigation_amount import investigate_amount
        return investigate_amount(evidence, provider)
    return investigate_duplicate(evidence, provider)


def investigate_duplicate(evidence, provider):
    started = datetime.now(timezone.utc).isoformat()
    model_input = model_evidence(evidence)
    model_result, model = provider.analyze(model_input)
    verification = model_input['financial_verification']
    if model_result.financial_classification != verification['classification']:
        raise CaseError('AI result contradicted verified accounting facts; no diagnosis was accepted.', 502)
    validate_monetary_claims(model_result, model_input)
    allowed = set(evidence["evidence_references"])
    for claim in model_result.facts + model_result.hypotheses:
        if not set(claim.evidence_refs) <= allowed:
            raise CaseError("AI result cited unavailable source records; no diagnosis was accepted.", 502)
    cause_refs = set(model_result.root_cause_evidence_refs)
    if not cause_refs <= allowed or PRIVATE_VALUE.search(model_result.root_cause_code):
        raise CaseError('AI result contains unavailable citations or simulator labels.', 502)
    operational_refs = {f"event:{r['id']}" for r in model_input['snapshot']['events'] if r['eventType'] != 'UNRECOGNIZED_EVENT' and r.get('relationshipValid')}
    operational_refs.update(f"request:{r['id']}" for r in model_input['snapshot']['requests'] if r['integrityValid'])
    if model_result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' and not cause_refs.intersection(operational_refs):
        raise CaseError('A cause hypothesis requires cited operational evidence; no diagnosis was accepted.', 502)
    # Safety checks verify source relationships after inference; they do not supply an answer.
    s = evidence['snapshot']
    a, b = s['original'], s['duplicate']
    requests = s.get('requests', [])
    consistent = bool(a and b and not s['linkConflict'] and all(r['integrityValid'] for r in requests)
        and a['senderId'] and a['receiverId'] and a['senderId'] == b['senderId'] and a['receiverId'] == b['receiverId']
        and a['amountCents'] == b['amountCents'] and a['currency'] == b['currency'])
    same = consistent and bool(a['paymentId'] and b['originalPaymentId'] == a['paymentId'] or
        len(requests) >= 2 and {r['paymentReference'] for r in requests} == {a['id'], b['id']} and len({r['businessInstructionId'] for r in requests}) == 1)
    separate = consistent and len(requests) == 2 and all(r['authorizationValid'] and r['origin'] == 'CUSTOMER' and not r['retryOfRequestId'] for r in requests)
    separate = separate and len({r['businessInstructionId'] for r in requests}) == len({r['authorizationId'] for r in requests}) == 2
    separate = separate and {r['paymentReference'] for r in requests} == {a['id'], b['id']}
    separate = separate and not any(e['eventType'] == 'RETRY_SUBMITTED' for e in s['events'])
    diagnosis, action = model_result.diagnosis_classification, model_result.recommended_action_code
    financial = verification['classification']
    if diagnosis == 'CONFIRMED_DUPLICATE_REQUEST' and not same or diagnosis == 'LEGITIMATE_SEPARATE_INSTRUCTIONS' and not separate:
        raise CaseError('AI relationship conclusion lacks consistent instruction evidence.', 502)
    if (action == 'CLOSE_HELD_DUPLICATE' and not (diagnosis == 'CONFIRMED_DUPLICATE_REQUEST' and same and financial == 'SINGLE_POSTING_CONFIRMED')
        or action == 'REVIEW_FALSE_POSITIVE_CLOSURE' and not (diagnosis == 'LEGITIMATE_SEPARATE_INSTRUCTIONS' and separate and financial == 'DOUBLE_POSTING_CONFIRMED')
        or action == 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION' and not (diagnosis == 'CONFIRMED_DUPLICATE_REQUEST' and same and financial == 'DOUBLE_POSTING_CONFIRMED')):
        raise CaseError('AI review recommendation is not supported by verified source facts.', 502)
    snapshot = evidence["snapshot"]
    completed = datetime.now(timezone.utc).isoformat()
    explanation = {
        "SINGLE_POSTING_CONFIRMED": "One payment-aligned posting is verified; source events record the repeated request held before execution.",
        "DOUBLE_POSTING_CONFIRMED": "Two distinct payment-aligned postings are verified; their intent must be assessed separately.",
        "NO_POSTING_CONFIRMED": "Both source requests are recorded as held before execution within this snapshot.",
        "EXECUTION_OUTCOME_UNKNOWN": "Source or ledger evidence is incomplete or conflicting; no financial-loss amount is asserted.",
    }[financial]
    cause = model_result.root_cause_code
    review_flags = authorization_review_flags(model_result, model_input['snapshot'], separate)
    record = getattr(provider, 'record_outcome', None)
    if record:
        record('ACCEPTED_WITH_REVIEW_FLAGS' if review_flags else 'ACCEPTED')
    return dict(case_id=snapshot["caseRecord"]["id"], investigation_id=f"INV-{uuid4()}",
        run_status="COMPLETED", started_at=started, completed_at=completed,
        evidence_snapshot_at=evidence["retrieved_at"], prototype=False, provider="openai", model=model,
        persistence="BROWSER_SESSION_ONLY", exception_type="DUPLICATE_TRANSACTION",
        diagnosis_classification=diagnosis, root_cause_code=cause,
        root_cause_title=model_result.root_cause_title, root_cause_explanation=model_result.root_cause_explanation,
        root_cause_status='MODEL_HYPOTHESIS' if cause != 'CAUSE_NOT_ESTABLISHED' else 'NOT_ESTABLISHED',
        root_cause_evidence_refs=model_result.root_cause_evidence_refs,
        evidence_strength='Evidence-cited model hypothesis; human review required.' if cause != 'CAUSE_NOT_ESTABLISHED' else 'Insufficient causal evidence.',
        unresolved_questions=list(dict.fromkeys(['Source evidence is a snapshot, not authorization for a financial action.'] + model_result.uncertainty)),
        payment_comparison=[snapshot["original"], snapshot["duplicate"]],
        financial_execution_assessment=dict(classification=financial, explanation=explanation,
                                             original=verification["original"], duplicate=verification["duplicate"]),
        financial_impact={k: v for k, v in verification.items() if k not in {'classification', 'original', 'duplicate'}},
        investigation_trace=snapshot["events"], supporting_evidence=snapshot,
        recommended_action_code=action,
        recommended_action=ACTION_TITLES[action],
        recommendation_reason=model_result.recommendation_reason,
        risk_consideration="Proposal only. Revalidate current evidence and obtain required human review/approval before any corrective action. No action was executed.",
        policy_review_required=True, evidence_references=evidence["evidence_references"],
        provider_metadata=getattr(provider, 'last_metadata', {}),
        review_flags=review_flags,
        validation_notes=['Schema, citation existence, accounting and recommendation prerequisites checked.',
            'Semantic citation support and causal reasoning require human evaluation.'],
        llm_analysis=model_result.model_dump())
