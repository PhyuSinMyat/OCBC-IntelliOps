"""Read-only evidence and deterministic validation for Amount Mismatch cases."""
import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import select, or_

from modules.core_banking.models import Account, LedgerEntry, LedgerJournal, LedgerRecord
from modules.core_banking.service import assess_journal
from modules.payment_processing.models import PaymentInstruction, ProcessingEvent, Transaction
from modules.payment_processing.service import aware
from .investigation_projection import parse_source, model_evidence, PRIVATE_VALUE
from .investigation_requests import request_evidence
from .investigation_schemas import ACTION_TITLES
from .investigation_validation import validate_monetary_claims
from .service import CaseError, get_case


def retrieve_amount_evidence(db, case_id, allowed_types=None):
    case = get_case(db, case_id)
    supported = allowed_types or {'Amount Mismatch', 'AMOUNT_MISMATCH'}
    if case.exception_type not in supported:
        raise CaseError('This collector supports only Amount Mismatch cases.', 409)
    payment = db.get(Transaction, case.transaction_id)
    if payment is None:
        raise CaseError('The case payment is unavailable.', 409)
    instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == payment.id))
    if instruction is None:
        raise CaseError('The payment instruction is unavailable.', 409)

    events = db.scalars(select(ProcessingEvent).where(ProcessingEvent.transaction_id == payment.id)
                        .order_by(ProcessingEvent.created_at, ProcessingEvent.id).limit(1001)).all()
    journals = db.scalars(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id == payment.id,
        LedgerJournal.payment_reference == payment.reference)).order_by(LedgerJournal.journal_ref).limit(201)).all()
    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id.in_([j.journal_id for j in journals]))
                         .order_by(LedgerEntry.entry_ref).limit(501)).all()
    legacy = db.scalars(select(LedgerRecord).where(LedgerRecord.transaction_id == payment.id)).all()
    if len(events) > 1000 or len(journals) > 200 or len(entries) > 500:
        raise CaseError("Evidence exceeds this investigation's bounded scope; manual review is required.", 422)
    account_ids = {instruction.sender_account_id, instruction.receiver_account_id, *(e.account_id for e in entries)}
    accounts = {a.account_id: a for a in db.scalars(select(Account).where(Account.account_id.in_(account_ids)))}

    event_dtos = []
    for event in events:
        payload, validation = parse_source(event)
        event_dtos.append(dict(id=str(event.id), paymentId=payment.reference, eventType=event.event_type,
            status=event.status, description=(event.details or '')[:4000], errorCode=event.error_code,
            requestId=str(event.request_id) if event.request_id else None, occurredAt=aware(event.created_at).isoformat(),
            correlationId=payload.get('correlation_id'), sourceData=payload, sourceValidation=validation))
    requests, uncertainty = request_evidence(db, [payment], [instruction], accounts, event_dtos)

    checks, valid = [], []
    for journal in journals:
        journal_entries = [entry for entry in entries if entry.journal_id == journal.journal_id]
        assessed = assess_journal(journal, journal_entries, accounts, payment, instruction)
        aligned = assessed['valid'] and not any(assessed[key] for key in ('currency_mismatch', 'party_mismatch', 'reference_mismatch'))
        row = dict(journalReference=journal.journal_ref, valid=aligned, status=journal.status,
            currency=journal.currency, debitTotal=format(assessed['debit'], '.2f'), creditTotal=format(assessed['credit'], '.2f'),
            reasons=assessed['reasons'] + [key for key in ('currency_mismatch', 'party_mismatch', 'reference_mismatch') if assessed[key]])
        checks.append(row)
        if aligned:
            valid.append((journal, assessed))

    expected = payment.amount
    posted = sum((assessment['debit'] for _, assessment in valid), Decimal(0))
    difference = posted - expected
    tolerance = Decimal(str((case.evidence or {}).get('tolerance', '0')))
    complete = bool(valid) and not legacy and len(valid) == len(journals)
    classification = 'EXECUTION_OUTCOME_UNKNOWN'
    if complete:
        classification = ('UNDERPOSTING_CONFIRMED' if difference < -tolerance else
                          'OVERPOSTING_CONFIRMED' if difference > tolerance else 'AMOUNT_MATCH_CONFIRMED')

    payment_dto = dict(id=payment.reference, paymentId=str(instruction.payment_id),
        senderId=accounts.get(instruction.sender_account_id).account_ref if accounts.get(instruction.sender_account_id) else None,
        receiverId=accounts.get(instruction.receiver_account_id).account_ref if accounts.get(instruction.receiver_account_id) else None,
        amountCents=int(expected * 100), currency=payment.currency, status=payment.status.title(),
        createdAt=aware(payment.created_at).isoformat(),
        completedAt=aware(instruction.completed_at).isoformat() if instruction.completed_at else None,
        businessReference=payment.payment_reference, originalPaymentId=None)
    assessment = dict(payment_ref=payment.reference, execution='Posted' if complete else 'Unknown',
        journals=[journal.journal_ref for journal in journals], valid_journals=[journal.journal_ref for journal, _ in valid],
        payment_status=payment.status, processing_state='COMPLETED_POSTED' if complete else 'PENDING_OR_UNKNOWN',
        reason='Aligned ledger entries verified; amount reconciliation is reported separately.' if complete else 'Financial execution is not fully verified.')
    empty = dict(payment_ref=None, execution='Unknown', journals=[], valid_journals=[], payment_status=None,
                 processing_state='NOT_APPLICABLE', reason='No second payment is part of an Amount Mismatch case.')
    amount = lambda value: format(value, '.2f')
    movements = []
    for account_id in sorted({entry.account_id for entry in entries if entry.journal_id in {j.journal_id for j, _ in valid}}, key=str):
        account = accounts.get(account_id)
        debit = sum((entry.amount for entry in entries if entry.account_id == account_id and entry.side == 'Debit'
                     and entry.journal_id in {j.journal_id for j, _ in valid}), Decimal(0))
        credit = sum((entry.amount for entry in entries if entry.account_id == account_id and entry.side == 'Credit'
                      and entry.journal_id in {j.journal_id for j, _ in valid}), Decimal(0))
        if account:
            movements.append(dict(accountReference=account.account_ref, currency=payment.currency,
                                  debit=amount(debit), credit=amount(credit), net=amount(credit - debit)))
    sender_ref = payment_dto['senderId']; receiver_ref = payment_dto['receiverId']
    impact = dict(completedPaymentCount=int(payment.status == 'COMPLETED'), confirmedPostedJournalCount=len(valid),
        validDebitTotals={payment.currency: amount(posted)} if valid else {}, validCreditTotals={payment.currency: amount(posted)} if valid else {},
        accountMovements=movements, senderFinancialMovement=next((m for m in movements if m['accountReference'] == sender_ref), None),
        receiverFinancialMovement=next((m for m in movements if m['accountReference'] == receiver_ref), None),
        journalValidation=checks, requestHistoryComplete=bool(requests), expectedAmount=amount(expected), postedAmount=amount(posted),
        difference=amount(difference), absoluteDifference=amount(abs(difference)), tolerance=amount(tolerance), outcomeUnknown=not complete)
    snapshot = dict(fixture=None, caseRecord=dict(id=f'CASE-{case.id:06d}', transactionId=payment.reference,
        relatedTransactionId=None, exceptionType=case.exception_type, severity=case.severity, status=case.status,
        createdAt=aware(case.created_at).isoformat()), original=payment_dto, duplicate=None, linkConflict=False,
        accounts=[dict(id=account.account_ref, currency=account.currency) for account in accounts.values()],
        journals=[dict(id=j.journal_ref, paymentId=j.payment_reference, sourcePaymentId=payment.reference,
            status=j.status, currency=j.currency, postedAt=aware(j.posted_at).isoformat() if j.posted_at else None) for j in journals],
        entries=[dict(id=e.entry_ref, journalId=next(j.journal_ref for j in journals if j.journal_id == e.journal_id),
            accountId=accounts[e.account_id].account_ref, side=e.side, amountCents=int(e.amount * 100), currency=e.currency, posted=e.posted) for e in entries],
        events=event_dtos, legacyPostings=[dict(id=r.id, amount=str(r.amount), currency=r.currency) for r in legacy],
        requests=requests, evidenceUncertainty=uncertainty,
        instructions=[dict(id=str(instruction.payment_id), transactionReference=payment.reference,
            idempotencyKeyHash=hashlib.sha256(instruction.idempotency_key.encode()).hexdigest())])
    references = [f"case:{snapshot['caseRecord']['id']}", f'payment:{payment.reference}',
                  f'instruction:{instruction.payment_id}']
    for key, prefix in (('events', 'event'), ('journals', 'journal'), ('entries', 'entry'), ('requests', 'request')):
        references.extend(f"{prefix}:{row['id']}" for row in snapshot[key])
    verified = dict(financial_classification=classification, original=assessment, duplicate=empty)
    evidence = dict(snapshot=snapshot, verified_assessment=verified, financial_impact=impact,
                    evidence_references=references, verified_assessment_scope='LEGACY_HEURISTIC_NOT_LLM_INPUT')
    from .investigation_projection import financial_verification
    evidence['financial_verification'] = financial_verification(evidence)
    return evidence


def investigate_amount(evidence, provider):
    started = datetime.now(timezone.utc).isoformat()
    model_input = model_evidence(evidence)
    result, model = provider.analyze(model_input)
    verification = model_input['financial_verification']
    if result.financial_classification != verification['classification']:
        raise CaseError('AI result contradicted verified amount reconciliation; no diagnosis was accepted.', 502)
    validate_monetary_claims(result, model_input)
    allowed = set(evidence['evidence_references'])
    for claim in result.facts + result.hypotheses:
        if not set(claim.evidence_refs) <= allowed:
            raise CaseError('AI result cited unavailable source records; no diagnosis was accepted.', 502)
    cause_refs = set(result.root_cause_evidence_refs)
    if not cause_refs <= allowed or PRIVATE_VALUE.search(result.root_cause_code):
        raise CaseError('AI result contains unavailable citations or simulator labels.', 502)
    operational = {f"event:{row['id']}" for row in model_input['snapshot']['events'] if row['eventType'] != 'UNRECOGNIZED_EVENT' and row.get('relationshipValid')}
    operational.update(f"request:{row['id']}" for row in model_input['snapshot']['requests'] if row['integrityValid'])
    if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' and not cause_refs.intersection(operational):
        raise CaseError('A cause hypothesis requires cited operational evidence; no diagnosis was accepted.', 502)
    financial = verification['classification']
    expected_diagnosis = 'CONFIRMED_AMOUNT_MISMATCH' if financial in {'UNDERPOSTING_CONFIRMED', 'OVERPOSTING_CONFIRMED'} else ('NO_AMOUNT_MISMATCH' if financial == 'AMOUNT_MATCH_CONFIRMED' else 'INSUFFICIENT_EVIDENCE')
    expected_action = {'UNDERPOSTING_CONFIRMED': 'REVIEW_SHORTFALL_ADJUSTMENT',
        'OVERPOSTING_CONFIRMED': 'REVIEW_OVERPOSTING_CORRECTION', 'AMOUNT_MATCH_CONFIRMED': 'REVIEW_FALSE_POSITIVE_CLOSURE',
        'EXECUTION_OUTCOME_UNKNOWN': 'ESCALATE_FOR_AMOUNT_VERIFICATION'}[financial]
    if result.diagnosis_classification != expected_diagnosis or result.recommended_action_code != expected_action:
        raise CaseError('AI amount conclusion or review recommendation contradicts verified source facts.', 502)
    snapshot = evidence['snapshot']; completed = datetime.now(timezone.utc).isoformat()
    record = getattr(provider, 'record_outcome', None)
    if record: record('ACCEPTED')
    return dict(case_id=snapshot['caseRecord']['id'], investigation_id=f'INV-{uuid4()}', run_status='COMPLETED',
        started_at=started, completed_at=completed, evidence_snapshot_at=evidence['retrieved_at'], prototype=False,
        provider='openai', model=model, persistence='BROWSER_SESSION_ONLY', exception_type='AMOUNT_MISMATCH',
        diagnosis_classification=result.diagnosis_classification, root_cause_code=result.root_cause_code,
        root_cause_title=result.root_cause_title, root_cause_explanation=result.root_cause_explanation,
        root_cause_status='MODEL_HYPOTHESIS' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'NOT_ESTABLISHED',
        root_cause_evidence_refs=result.root_cause_evidence_refs,
        evidence_strength='Evidence-cited model hypothesis; human review required.' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'Insufficient causal evidence.',
        unresolved_questions=list(dict.fromkeys(['Source evidence is a snapshot, not authorization for a financial action.'] + result.uncertainty)),
        payment_comparison=[snapshot['original']], financial_execution_assessment=dict(classification=financial,
            explanation='Expected and posted amounts were reconciled from the payment instruction and valid aligned journal entries.',
            original=evidence['verified_assessment']['original'], duplicate=evidence['verified_assessment']['duplicate']),
        financial_impact=evidence['financial_impact'], investigation_trace=snapshot['events'], supporting_evidence=snapshot,
        recommended_action_code=expected_action, recommended_action=ACTION_TITLES[expected_action],
        recommendation_reason=result.recommendation_reason,
        risk_consideration='Proposal only. Revalidate current evidence and obtain required human review/approval before any corrective action. No action was executed.',
        policy_review_required=True, evidence_references=evidence['evidence_references'],
        provider_metadata=getattr(provider, 'last_metadata', {}), review_flags=[],
        validation_notes=['Schema, citations, amount reconciliation and recommendation prerequisites checked.',
                          'Semantic citation support and causal reasoning require human evaluation.'],
        llm_analysis=result.model_dump())
