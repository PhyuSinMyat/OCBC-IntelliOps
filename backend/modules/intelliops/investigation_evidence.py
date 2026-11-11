"""Read-only retrieval and financial/source-evidence bounds for duplicate cases."""
import hashlib
from datetime import datetime
from decimal import Decimal
from sqlalchemy import select, or_
from modules.core_banking.models import Account, LedgerJournal, LedgerEntry, LedgerRecord
from modules.core_banking.service import assess_journal
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from modules.payment_processing.service import aware
from .service import get_case, CaseError
from .investigation_projection import parse_source, financial_verification
from .investigation_requests import request_evidence


def source_data(event):
    return parse_source(event)[0]


def retrieve_evidence(db, case_id):
    case = get_case(db, case_id)
    if case.exception_type not in ("Duplicate Transaction", "DUPLICATE_TRANSACTION"):
        raise CaseError("Only Duplicate Transaction investigations are supported.", 409)
    duplicate = db.get(Transaction, case.transaction_id)
    if duplicate is None:
        raise CaseError('The case payment is unavailable.', 409)
    di = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == duplicate.id))
    oi = db.get(PaymentInstruction, di.original_payment_id) if di and di.original_payment_id else None
    explicit = db.get(Transaction, oi.transaction_id) if oi else None
    detected = db.scalar(select(Transaction).where(Transaction.reference == (case.evidence or {}).get("originalReference", "")))
    related_id = case.related_transaction_id
    persisted = db.get(Transaction, related_id) if related_id else None
    original = persisted if related_id else explicit or detected
    if original and original.id == duplicate.id:
        original = None
    sources = {p.id for p in (persisted, explicit, detected) if p}
    conflict = len(sources) > 1 or bool(related_id and (not persisted or related_id == duplicate.id))
    if original:
        oi = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == original.id))
    else:
        oi = None
    payments = [p for p in (original, duplicate) if p]
    ids, refs = [p.id for p in payments], [p.reference for p in payments]
    events = db.scalars(select(ProcessingEvent).where(ProcessingEvent.transaction_id.in_(ids))
                        .order_by(ProcessingEvent.created_at, ProcessingEvent.id).limit(1001)).all()
    journals = db.scalars(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id.in_(ids),
        LedgerJournal.payment_reference.in_(refs))).order_by(LedgerJournal.journal_ref).limit(201)).all()
    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id.in_([j.journal_id for j in journals]))
                         .order_by(LedgerEntry.entry_ref).limit(501)).all()
    account_ids = {e.account_id for e in entries}
    for i in (oi, di):
        if i:
            account_ids.update((i.sender_account_id, i.receiver_account_id))
    accounts = {a.account_id: a for a in db.scalars(select(Account).where(Account.account_id.in_(account_ids)))}
    legacy = db.scalars(select(LedgerRecord).where(LedgerRecord.transaction_id.in_(ids))).all()
    if len(events) > 1000 or len(entries) > 500 or len(journals) > 200:
        raise CaseError("Evidence exceeds this investigation's bounded scope; manual review is required.", 422)
    event_dtos = []
    for e in events:
        payload, validation = parse_source(e)
        event_dtos.append(dict(id=str(e.id), paymentId=next(p.reference for p in payments if p.id == e.transaction_id),
            eventType=e.event_type, status=e.status, description=(e.details or "")[:4000], errorCode=e.error_code,
            requestId=str(e.request_id) if e.request_id else None,
            occurredAt=aware(e.created_at).isoformat(), correlationId=payload.get("correlation_id"), sourceData=payload,
            sourceValidation=validation))
    pairs = [(p, i) for p, i in ((original, oi), (duplicate, di)) if p]
    requests, uncertainty = request_evidence(db, [p for p, _ in pairs], [i for _, i in pairs], accounts, event_dtos)
    if conflict:
        uncertainty.append('Persisted case, original-instruction and detection relationships conflict or are missing.')
    def payment_dto(p, instruction):
        if p is None:
            return None
        auth = [e for e in event_dtos if e["paymentId"] == p.reference and e["eventType"] == "PAYMENT_AUTHORIZED"
                and e['relationshipValid']
                and e["status"] == "COMPLETED" and e["sourceData"].get("authorized") is True
                and e["sourceData"].get("authorization_id") and e["sourceData"].get("intent_id")]
        intent = auth[0]["sourceData"]["intent_id"] if len(auth) == 1 else None
        return dict(id=p.reference, paymentId=str(instruction.payment_id) if instruction else None,
            senderId=accounts[instruction.sender_account_id].account_ref if instruction and instruction.sender_account_id in accounts else None,
            receiverId=accounts[instruction.receiver_account_id].account_ref if instruction and instruction.receiver_account_id in accounts else None,
            amountCents=int(p.amount * 100), currency=p.currency, status=p.status.title(),
            createdAt=aware(p.created_at).isoformat(), completedAt=aware(instruction.completed_at).isoformat() if instruction and instruction.completed_at else None,
            businessReference=p.payment_reference, authorizedIntentId=intent, instructionVerified=bool(intent),
            originalPaymentId=str(instruction.original_payment_id) if instruction and instruction.original_payment_id else None)
    journal_checks = {}
    def assessment(p, instruction):
        if p is None:
            return dict(payment_ref=None, execution="Unknown", journals=[], valid_journals=[], reason="Payment unavailable.")
        linked = [j for j in journals if j.source_transaction_id == p.id or j.payment_reference == p.reference]
        valid = []
        for j in linked:
            a = assess_journal(j, [e for e in entries if e.journal_id == j.journal_id], accounts, p, instruction)
            aligned = bool(instruction and a['valid'] and a['debit'] == p.amount and not any(a[k] for k in ('currency_mismatch', 'party_mismatch', 'reference_mismatch')))
            journal_checks[j.journal_ref] = dict(journalReference=j.journal_ref, valid=aligned,
                status=j.status, currency=j.currency, debitTotal=str(a['debit']), creditTotal=str(a['credit']),
                reasons=a['reasons'] + ([] if instruction else ['INSTRUCTION_UNAVAILABLE']) +
                [k for k in ('currency_mismatch', 'party_mismatch', 'reference_mismatch') if a[k]] + ([] if a['debit'] == p.amount else ['PAYMENT_AMOUNT_MISMATCH']))
            if aligned:
                valid.append(j.journal_ref)
        es = [e for e in events if e.transaction_id == p.id]
        holds = [e for e in event_dtos if e['paymentId'] == p.reference and e['eventType'] in {'DUPLICATE_BLOCKED', 'DUPLICATE_REJECTED'}
                 and e['relationshipValid'] and e['sourceData'].get('posting_started') is not True]
        held = (p.status in ("HELD", "PENDING", "REJECTED") and bool(holds)
                and not linked and not any(r.transaction_id == p.id for r in legacy)
                and not any(e.event_type in ("PROCESSING_STARTED", "LEDGER_POSTED", "PROCESSING_COMPLETED") for e in es))
        posted = p.status == 'COMPLETED' and bool(valid) and len(valid) == len(linked) and not any(r.transaction_id == p.id for r in legacy)
        return dict(payment_ref=p.reference, execution="Posted" if posted else "Not Started" if held else "Unknown",
            journals=[j.journal_ref for j in linked], valid_journals=valid,
            payment_status=p.status, processing_state='COMPLETED_POSTED' if posted else 'HELD_BEFORE_EXECUTION' if held else
                'FAILED_OR_REJECTED' if p.status in {'FAILED', 'REJECTED'} else 'PENDING_OR_UNKNOWN',
            reason="Payment-aligned ledger entries verified." if posted else "Source hold/rejection precedes execution in this snapshot." if held else "Financial execution is not fully verified.")
    a, b = payment_dto(original, oi), payment_dto(duplicate, di)
    oa, da = assessment(original, oi), assessment(duplicate, di)
    financial = "EXECUTION_OUTCOME_UNKNOWN"
    if oa["execution"] == "Posted" and len(oa["valid_journals"]) == 1 and da["execution"] == "Not Started":
        financial = "SINGLE_POSTING_CONFIRMED"
    elif oa["execution"] == da["execution"] == "Posted" and len(oa["valid_journals"]) == len(da["valid_journals"]) == 1 and oa["valid_journals"] != da["valid_journals"]:
        financial = "DOUBLE_POSTING_CONFIRMED"
    elif oa["execution"] == da["execution"] == "Not Started":
        financial = "NO_POSTING_CONFIRMED"
    snapshot = dict(fixture=None, caseRecord=dict(id=f"CASE-{case.id:06d}", transactionId=duplicate.reference,
        relatedTransactionId=original.reference if original else None,
        exceptionType=case.exception_type, severity=case.severity, status=case.status, evidence=case.evidence or {},
        createdAt=aware(case.created_at).isoformat()), original=a, duplicate=b, linkConflict=conflict,
        accounts=[dict(id=x.account_ref, currency=x.currency) for x in accounts.values()],
        journals=[dict(id=j.journal_ref, paymentId=j.payment_reference, sourcePaymentId=next((p.reference for p in payments if p.id == j.source_transaction_id), None),
            status=j.status, currency=j.currency, postedAt=aware(j.posted_at).isoformat() if j.posted_at else None) for j in journals],
        entries=[dict(id=e.entry_ref, journalId=next(j.journal_ref for j in journals if j.journal_id == e.journal_id),
            accountId=accounts[e.account_id].account_ref, side=e.side, amountCents=int(e.amount * 100), currency=e.currency, posted=e.posted) for e in entries],
        events=event_dtos, legacyPostings=[dict(id=r.id, amount=str(r.amount), currency=r.currency) for r in legacy],
        requests=requests, evidenceUncertainty=uncertainty,
        instructions=[dict(id=str(i.payment_id), transactionReference=p.reference,
            idempotencyKeyHash=hashlib.sha256(i.idempotency_key.encode()).hexdigest()) for p, i in ((original, oi), (duplicate, di)) if p and i])
    bounds = evidence_bounds(snapshot, financial)
    bounds['uncertainty'].extend(uncertainty)
    bounds['uncertainty'].extend('Event ' + e['id'] + ' contains invalid structured fields.' for e in event_dtos if e['sourceValidation']['errors'])
    impact = financial_impact(payments, journals, entries, accounts, journal_checks, snapshot, bounds, oa, da)
    citations = [f"case:{snapshot['caseRecord']['id']}"]
    for key, prefix in (("events", "event"), ("journals", "journal"), ("entries", "entry"), ("instructions", "instruction"), ('requests', 'request')):
        citations.extend(f"{prefix}:{r['id']}" for r in snapshot[key])
    citations.extend(f"payment:{p['id']}" for p in (a, b) if p)
    result = dict(snapshot=snapshot, verified_assessment={**bounds, "original": oa, "duplicate": da}, financial_impact=impact, evidence_references=citations,
        verified_assessment_scope='LEGACY_HEURISTIC_NOT_LLM_INPUT')
    result['financial_verification'] = financial_verification(result)
    return result


def financial_impact(payments, journals, entries, accounts, checks, snapshot, bounds, original, duplicate):
    """Aggregate each verified journal once; currencies and debit/credit stay separate."""
    valid = {j.journal_id for j in journals if checks.get(j.journal_ref, {}).get('valid')}
    debit, credit, movements = {}, {}, {}
    for entry in entries:
        if entry.journal_id not in valid:
            continue
        totals = debit if entry.side == 'Debit' else credit
        totals[entry.currency] = totals.get(entry.currency, Decimal(0)) + entry.amount
        account = accounts.get(entry.account_id)
        if account:
            movement = movements.setdefault((account.account_ref, entry.currency), {'Debit': Decimal(0), 'Credit': Decimal(0)})
            movement[entry.side] += entry.amount
    amount = lambda value: format(value, '.2f')
    account_movements = [dict(accountReference=ref, currency=currency, debit=amount(sides['Debit']),
        credit=amount(sides['Credit']), net=amount(sides['Credit'] - sides['Debit']))
        for (ref, currency), sides in sorted(movements.items())]
    a, b = snapshot['original'], snapshot['duplicate']
    same = bounds['diagnosis_classification'] == 'CONFIRMED_DUPLICATE_REQUEST'
    certain = bounds['financial_classification'] != 'EXECUTION_OUTCOME_UNKNOWN' and not snapshot['linkConflict']
    expected, excess = None, None
    if same and certain and a and b and all(r['integrityValid'] for r in snapshot['requests']):
        transfer = next(p.amount for p in payments if p.reference == a['id'])
        expected = dict(currency=a['currency'], amount=amount(transfer), senderAccount=a['senderId'], receiverAccount=a['receiverId'])
        excess = dict(currency=a['currency'], amount=amount(max(Decimal(0), debit.get(a['currency'], Decimal(0)) - transfer)))
    def party_movement(field):
        if not a or not b or not a[field] or a[field] != b[field]:
            return None
        return next((r for r in account_movements if r['accountReference'] == a[field] and r['currency'] == a['currency']), None)
    return dict(completedPaymentCount=sum(p.status == 'COMPLETED' for p in payments),
        confirmedPostedJournalCount=len(valid), validDebitTotals={key: amount(value) for key, value in sorted(debit.items())},
        validCreditTotals={key: amount(value) for key, value in sorted(credit.items())},
        accountMovements=account_movements, senderFinancialMovement=party_movement('senderId'),
        receiverFinancialMovement=party_movement('receiverId'), expectedMovementForOneTransfer=expected,
        excessPostingAmount=excess, journalValidation=list(checks.values()),
        outcomeUnknown=not certain, requestHistoryComplete=len({r['paymentReference'] for r in snapshot['requests']}) == len(payments),
        relationshipUncertain=snapshot['linkConflict'] or bounds['diagnosis_classification'] in {'SUSPECTED_DUPLICATE', 'INSUFFICIENT_EVIDENCE'} or
            len({r['paymentReference'] for r in snapshot['requests']}) != len(payments) or not all(r['integrityValid'] for r in snapshot['requests']),
        originalExecution=original['execution'], duplicateExecution=duplicate['execution'])


def evidence_bounds(s, financial):
    a, b = s["original"], s["duplicate"]
    matching = bool(a and b and a["senderId"] and a["receiverId"] and a["senderId"] == b["senderId"]
        and a["receiverId"] == b["receiverId"] and a["amountCents"] == b["amountCents"] and a["currency"] == b["currency"])
    direct = bool(a and b and a["paymentId"] and b["originalPaymentId"] == a["paymentId"])
    integrity = not s['linkConflict'] and all(r['integrityValid'] for r in s.get('requests', []))
    separate = bool(integrity and a and b and a["instructionVerified"] and b["instructionVerified"]
        and a["authorizedIntentId"] != b["authorizedIntentId"] and not direct and not s["linkConflict"])
    auths = [e for e in s["events"] if e.get('relationshipValid', False) and e["eventType"] == "PAYMENT_AUTHORIZED" and e["status"] == "COMPLETED"
             and e["sourceData"].get("authorized") is True and e["sourceData"].get("authorization_id") and e["sourceData"].get("intent_id")]
    if separate:
        separate = len({e["sourceData"].get("authorization_id") for e in auths}) == 2 and not any(
            r['retryOfRequestId'] for r in s.get('requests', [])) and not any(e['eventType'] == 'RETRY_SUBMITTED' for e in s['events'])
    submissions = [e for e in s["events"] if e.get('relationshipValid', False) and e["eventType"] == "CLIENT_SUBMISSION"
        and e["sourceData"].get("origin") == "CUSTOMER" and e["sourceData"].get("trigger") == "USER_SUBMIT"]
    pair = [e for e in submissions if a and e["paymentId"] == a["id"]], [e for e in submissions if b and e["paymentId"] == b["id"]]
    repeated = bool(all(len(es) == 1 for es in pair) and pair[0][0]["sourceData"].get("intent_id")
        and pair[0][0]["sourceData"].get("intent_id") == pair[1][0]["sourceData"].get("intent_id")
        and pair[0][0]["sourceData"].get("submission_id") and pair[1][0]["sourceData"].get("submission_id")
        and pair[0][0]["sourceData"]["submission_id"] != pair[1][0]["sourceData"]["submission_id"])
    same = matching and (direct or repeated) and not separate and integrity
    diagnosis = "LEGITIMATE_SEPARATE_INSTRUCTIONS" if separate else "CONFIRMED_DUPLICATE_REQUEST" if same else "SUSPECTED_DUPLICATE" if a and b else "INSUFFICIENT_EVIDENCE"
    cause = "LEGITIMATE_REPEATED_PAYMENT" if separate else "CAUSE_NOT_ESTABLISHED"
    cause_refs = []
    if same and repeated and financial == "SINGLE_POSTING_CONFIRMED":
        cause = "CUSTOMER_DOUBLE_SUBMISSION"
        cause_refs = ["event:" + e["id"] for es in pair for e in es]
    if same and financial == "DOUBLE_POSTING_CONFIRMED":
        timeouts = [e for e in s["events"] if e.get('relationshipValid', False) and a and e["paymentId"] == a["id"] and e["eventType"] == "ACK_TIMEOUT" and e["sourceData"].get("origin") == "SYSTEM"]
        for timeout in timeouts:
            correlation = timeout["sourceData"].get("correlation_id")
            retry = [e for e in s["events"] if e.get('relationshipValid', False) and e["paymentId"] == b["id"] and e["eventType"] == "RETRY_SUBMITTED"
                and e["sourceData"].get("origin") == "SYSTEM" and e["sourceData"].get("trigger") == "AUTOMATIC_RETRY"
                and correlation and e["sourceData"].get("correlation_id") == correlation
                and e["sourceData"].get("original_payment_ref") == a["id"]
                and datetime.fromisoformat(e["occurredAt"]) >= datetime.fromisoformat(timeout["occurredAt"])]
            failure = [e for e in s["events"] if e.get('relationshipValid', False) and e["paymentId"] == b["id"] and e["eventType"] == "IDEMPOTENCY_CHECK_FAILED"
                and e["sourceData"].get("origin") == "SYSTEM" and correlation
                and e["sourceData"].get("correlation_id") == correlation and e["sourceData"].get("original_payment_ref") == a["id"]
                and e['sourceData'].get('lookup_result') == 'MISS' and e['sourceData'].get('authoritative_execution_present') is True]
            stages = {e["eventType"] for e in s["events"] if e["paymentId"] == b["id"]}
            if (len(retry) == len(failure) == 1 and {"PROCESSING_STARTED", "PROCESSING_COMPLETED"} <= stages
                    and datetime.fromisoformat(failure[0]["occurredAt"]) >= datetime.fromisoformat(retry[0]["occurredAt"])):
                cause = "IDEMPOTENCY_CONTROL_FAILURE"
                cause_refs = ["event:" + e["id"] for e in (timeout, retry[0], failure[0])]
    if separate:
        cause_refs = ["event:" + e["id"] for e in auths]
    action = "REVIEW_FALSE_POSITIVE_CLOSURE" if separate and financial == "DOUBLE_POSTING_CONFIRMED" else (
        "CLOSE_HELD_DUPLICATE" if same and financial == "SINGLE_POSTING_CONFIRMED" else
        "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION" if same and financial == "DOUBLE_POSTING_CONFIRMED" else "ESCALATE_FOR_PAYMENT_VERIFICATION")
    return dict(diagnosis_classification=diagnosis, root_cause_code=cause, financial_classification=financial,
                recommended_action_code=action, required_cause_references=cause_refs,
                uncertainty=["Current source evidence is a snapshot, not authorization for a financial action."] +
                (["No authoritative source events establish why the second request was submitted."] if cause == "CAUSE_NOT_ESTABLISHED" else []))
