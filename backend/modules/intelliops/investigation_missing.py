"""Read-only evidence and deterministic validation for Missing Ledger Posting cases."""
import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import or_, select

from modules.core_banking.models import Account, LedgerEntry, LedgerJournal, LedgerRecord
from modules.core_banking.service import assess_journal
from modules.payment_processing.models import PaymentInstruction, ProcessingEvent, Transaction
from modules.payment_processing.service import aware
from .investigation_projection import PRIVATE_VALUE, financial_verification, model_evidence, parse_source
from .investigation_requests import request_evidence
from .investigation_schemas import ACTION_TITLES
from .investigation_validation import validate_monetary_claims
from .service import CaseError, get_case


def retrieve_missing_evidence(db, case_id):
    case = get_case(db, case_id)
    if case.exception_type not in {'Missing Ledger Posting', 'MISSING_LEDGER_POSTING'}:
        raise CaseError('This collector supports only Missing Ledger Posting cases.', 409)
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
    account_ids = {instruction.sender_account_id, instruction.receiver_account_id, *(entry.account_id for entry in entries)}
    accounts = {account.account_id: account for account in db.scalars(select(Account).where(Account.account_id.in_(account_ids)))}

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
        aligned = assessed['valid'] and assessed['debit'] == payment.amount and not any(
            assessed[key] for key in ('currency_mismatch', 'party_mismatch', 'reference_mismatch'))
        checks.append(dict(journalReference=journal.journal_ref, valid=aligned, status=journal.status,
            currency=journal.currency, debitTotal=format(assessed['debit'], '.2f'), creditTotal=format(assessed['credit'], '.2f'),
            reasons=assessed['reasons'] + [key for key in ('currency_mismatch', 'party_mismatch', 'reference_mismatch') if assessed[key]]
                + ([] if assessed['debit'] == payment.amount else ['PAYMENT_AMOUNT_MISMATCH'])))
        if aligned:
            valid.append((journal, assessed))

    source_complete = payment.status == 'COMPLETED' and instruction.completed_at is not None
    no_records = not journals and not legacy
    valid_posting = len(valid) == len(journals) == 1 and not legacy
    classification = ('NO_POSTING_RECORD_CONFIRMED' if source_complete and no_records else
                      'POSTING_RECORD_PRESENT' if valid_posting else 'EXECUTION_OUTCOME_UNKNOWN')
    payment_dto = dict(id=payment.reference, paymentId=str(instruction.payment_id),
        senderId=accounts.get(instruction.sender_account_id).account_ref if accounts.get(instruction.sender_account_id) else None,
        receiverId=accounts.get(instruction.receiver_account_id).account_ref if accounts.get(instruction.receiver_account_id) else None,
        amountCents=int(payment.amount * 100), currency=payment.currency, status=payment.status.title(),
        createdAt=aware(payment.created_at).isoformat(),
        completedAt=aware(instruction.completed_at).isoformat() if instruction.completed_at else None,
        businessReference=payment.payment_reference, originalPaymentId=None)
    assessment = dict(payment_ref=payment.reference,
        execution='No Posting Record' if classification == 'NO_POSTING_RECORD_CONFIRMED' else 'Posted' if classification == 'POSTING_RECORD_PRESENT' else 'Unknown',
        journals=[journal.journal_ref for journal in journals], valid_journals=[journal.journal_ref for journal, _ in valid],
        payment_status=payment.status, processing_state='SOURCE_COMPLETED_NO_POSTING' if classification == 'NO_POSTING_RECORD_CONFIRMED'
            else 'COMPLETED_POSTED' if classification == 'POSTING_RECORD_PRESENT' else 'PENDING_OR_UNKNOWN',
        reason='No modern journal or legacy posting exists in this bounded snapshot.' if classification == 'NO_POSTING_RECORD_CONFIRMED'
            else 'One valid payment-aligned posted journal is present.' if classification == 'POSTING_RECORD_PRESENT'
            else 'Ledger execution is not fully verified.')
    empty = dict(payment_ref=None, execution='Unknown', journals=[], valid_journals=[], payment_status=None,
                 processing_state='NOT_APPLICABLE', reason='No second payment is part of a Missing Ledger Posting case.')
    posted = sum((item['debit'] for _, item in valid), Decimal(0))
    amount = lambda value: format(value, '.2f')
    impact = dict(completedPaymentCount=int(payment.status == 'COMPLETED'), confirmedPostedJournalCount=len(valid),
        validDebitTotals={payment.currency: amount(posted)} if valid else {},
        validCreditTotals={payment.currency: amount(posted)} if valid else {}, accountMovements=[],
        senderFinancialMovement=None, receiverFinancialMovement=None, journalValidation=checks,
        requestHistoryComplete=bool(requests), expectedAmount=amount(payment.amount), linkedJournalCount=len(journals),
        legacyRecordCount=len(legacy), paymentCompletionVerified=payment.status == 'COMPLETED',
        instructionCompletionVerified=instruction.completed_at is not None, postingRecordAbsent=no_records,
        outcomeUnknown=classification == 'EXECUTION_OUTCOME_UNKNOWN')
    snapshot = dict(fixture=None, caseRecord=dict(id=f'CASE-{case.id:06d}', transactionId=payment.reference,
        relatedTransactionId=None, exceptionType=case.exception_type, severity=case.severity, status=case.status,
        createdAt=aware(case.created_at).isoformat()), original=payment_dto, duplicate=None, linkConflict=False,
        accounts=[dict(id=account.account_ref, currency=account.currency) for account in accounts.values()],
        journals=[dict(id=journal.journal_ref, paymentId=journal.payment_reference, sourcePaymentId=payment.reference,
            status=journal.status, currency=journal.currency, postedAt=aware(journal.posted_at).isoformat() if journal.posted_at else None) for journal in journals],
        entries=[dict(id=entry.entry_ref, journalId=next(j.journal_ref for j in journals if j.journal_id == entry.journal_id),
            accountId=accounts[entry.account_id].account_ref, side=entry.side, amountCents=int(entry.amount * 100),
            currency=entry.currency, posted=entry.posted) for entry in entries], events=event_dtos,
        legacyPostings=[dict(id=record.id, amount=str(record.amount), currency=record.currency) for record in legacy],
        requests=requests, evidenceUncertainty=uncertainty,
        instructions=[dict(id=str(instruction.payment_id), transactionReference=payment.reference,
            idempotencyKeyHash=hashlib.sha256(instruction.idempotency_key.encode()).hexdigest())])
    references = [f"case:{snapshot['caseRecord']['id']}", f'payment:{payment.reference}', f'instruction:{instruction.payment_id}']
    for key, prefix in (('events', 'event'), ('journals', 'journal'), ('entries', 'entry'), ('requests', 'request')):
        references.extend(f"{prefix}:{row['id']}" for row in snapshot[key])
    verified = dict(financial_classification=classification, original=assessment, duplicate=empty)
    evidence = dict(snapshot=snapshot, verified_assessment=verified, financial_impact=impact,
                    evidence_references=references, verified_assessment_scope='LEGACY_HEURISTIC_NOT_LLM_INPUT')
    evidence['financial_verification'] = financial_verification(evidence)
    return evidence


def investigate_missing(evidence, provider):
    started = datetime.now(timezone.utc).isoformat()
    model_input = model_evidence(evidence)
    result, model = provider.analyze(model_input)
    verification = model_input['financial_verification']
    if result.financial_classification != verification['classification']:
        raise CaseError('AI result contradicted verified ledger-record facts; no diagnosis was accepted.', 502)
    validate_monetary_claims(result, model_input)
    allowed = set(evidence['evidence_references'])
    for claim in result.facts + result.hypotheses:
        if not set(claim.evidence_refs) <= allowed:
            raise CaseError('AI result cited unavailable source records; no diagnosis was accepted.', 502)
    cause_refs = set(result.root_cause_evidence_refs)
    if not cause_refs <= allowed or PRIVATE_VALUE.search(result.root_cause_code):
        raise CaseError('AI result contains unavailable citations or simulator labels.', 502)
    operational = {f"event:{row['id']}" for row in model_input['snapshot']['events']
                   if row['eventType'] != 'UNRECOGNIZED_EVENT' and row.get('relationshipValid')}
    operational.update(f"request:{row['id']}" for row in model_input['snapshot']['requests'] if row['integrityValid'])
    if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' and not cause_refs.intersection(operational):
        raise CaseError('A cause hypothesis requires cited operational evidence; no diagnosis was accepted.', 502)
    financial = verification['classification']
    expected_diagnosis = {'NO_POSTING_RECORD_CONFIRMED': 'CONFIRMED_MISSING_POSTING',
        'POSTING_RECORD_PRESENT': 'POSTING_RECORD_PRESENT',
        'EXECUTION_OUTCOME_UNKNOWN': 'INSUFFICIENT_EVIDENCE'}[financial]
    expected_action = {'NO_POSTING_RECORD_CONFIRMED': 'REVIEW_MISSING_POSTING_REMEDIATION',
        'POSTING_RECORD_PRESENT': 'REVIEW_FALSE_POSITIVE_CLOSURE',
        'EXECUTION_OUTCOME_UNKNOWN': 'ESCALATE_FOR_LEDGER_VERIFICATION'}[financial]
    if result.diagnosis_classification != expected_diagnosis or result.recommended_action_code != expected_action:
        raise CaseError('AI missing-posting conclusion or recommendation contradicts verified source facts.', 502)
    snapshot = evidence['snapshot']; completed = datetime.now(timezone.utc).isoformat()
    record = getattr(provider, 'record_outcome', None)
    if record: record('ACCEPTED')
    return dict(case_id=snapshot['caseRecord']['id'], investigation_id=f'INV-{uuid4()}', run_status='COMPLETED',
        started_at=started, completed_at=completed, evidence_snapshot_at=evidence['retrieved_at'], prototype=False,
        provider='openai', model=model, persistence='BROWSER_SESSION_ONLY', exception_type='MISSING_LEDGER_POSTING',
        diagnosis_classification=result.diagnosis_classification, root_cause_code=result.root_cause_code,
        root_cause_title=result.root_cause_title, root_cause_explanation=result.root_cause_explanation,
        root_cause_status='MODEL_HYPOTHESIS' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'NOT_ESTABLISHED',
        root_cause_evidence_refs=result.root_cause_evidence_refs,
        evidence_strength='Evidence-cited model hypothesis; human review required.' if result.root_cause_code != 'CAUSE_NOT_ESTABLISHED' else 'Insufficient causal evidence.',
        unresolved_questions=list(dict.fromkeys(['Source evidence is a snapshot, not authorization to create a financial posting.'] + result.uncertainty)),
        payment_comparison=[snapshot['original']], financial_execution_assessment=dict(classification=financial,
            explanation='The completed payment source was checked against current modern journals and legacy posting records.',
            original=evidence['verified_assessment']['original'], duplicate=evidence['verified_assessment']['duplicate']),
        financial_impact=evidence['financial_impact'], investigation_trace=snapshot['events'], supporting_evidence=snapshot,
        recommended_action_code=expected_action, recommended_action=ACTION_TITLES[expected_action],
        recommendation_reason=result.recommendation_reason,
        risk_consideration='Proposal only. Recheck current and legacy ledgers and obtain required approval before any posting. No action was executed.',
        policy_review_required=True, evidence_references=evidence['evidence_references'],
        provider_metadata=getattr(provider, 'last_metadata', {}), review_flags=[],
        validation_notes=['Schema, citations, source completion, ledger absence and recommendation prerequisites checked.',
                          'Semantic citation support and causal reasoning require human evaluation.'],
        llm_analysis=result.model_dump())
