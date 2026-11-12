"""Deterministic source evaluation with durable rule and recovery observations."""
import hashlib
import json
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal
from sqlalchemy import select, text, or_
from sqlalchemy.orm import defer
from sqlalchemy.exc import IntegrityError
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from modules.payment_processing.service import simulation_now, aware, reconciliation_seconds
from modules.core_banking.models import Account, LedgerJournal, LedgerEntry, LedgerRecord
from modules.core_banking.service import assess_journal
from .models import ExceptionCase, ExceptionCaseAction, AuditEvent, DetectionObservation
from .rules import load_rules

TERMINAL = {"RESOLVED", "CLOSED"}
DETECTOR_LOCK = 731096062
LEDGER_RULES = {"MISSING_LEDGER_POSTING", "UNMATCHED_TRANSACTION", "AMOUNT_MISMATCH",
                "INVALID_LEDGER_POSTING", "LEDGER_ACCOUNT_MISMATCH", "LEDGER_CURRENCY_MISMATCH"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def due_at(tx, instruction, config):
    if "reconciliation_seconds" in config:
        return aware(tx.created_at) + timedelta(seconds=config["reconciliation_seconds"])
    return (aware(instruction.reconciliation_due_at) if instruction else None) or (
        aware(tx.created_at) + timedelta(seconds=reconciliation_seconds()))


def posting_assessment(payment, instruction, data):
    if instruction is None:
        return [], False
    journals = data["journals_by_tx"][payment.id]
    refs = []
    for journal in journals:
        a = assess_journal(journal, data["entries"][journal.journal_id], data["accounts"], payment, instruction)
        if a["valid"] and a["debit"] == payment.amount and not any(a[k] for k in (
                "currency_mismatch", "party_mismatch", "reference_mismatch")):
            refs.append(journal.journal_ref)
    return refs, len(refs) == len(journals) and not data["legacy"][payment.id]


def evaluate(tx, instruction, data, policies, now):
    """Pure rule evaluation. No source writes, invented events or inferred causes."""
    result = {}
    linked, legacy = data["journals_by_tx"][tx.id], data["legacy"][tx.id]
    assessed = [(j, assess_journal(j, data["entries"][j.journal_id], data["accounts"], tx, instruction)) for j in linked]
    valid = [(j, a) for j, a in assessed if a["valid"] and not any(
        a[k] for k in ("currency_mismatch", "party_mismatch", "reference_mismatch"))]
    if tx.status == "FAILED":
        result["PAYMENT_PROCESSING_FAILURE"] = {"status": tx.status, "failureCode": instruction.failure_code if instruction else None}
    if tx.status == "COMPLETED":
        details = [dict(journalReference=j.journal_ref, status=j.status, currency=j.currency,
                        paymentReference=j.payment_reference, sourceTransactionId=j.source_transaction_id,
                        postedAt=aware(j.posted_at).isoformat() if j.posted_at else None,
                        entries=[dict(id=e.entry_ref, accountId=str(e.account_id), side=e.side,
                                      amount=str(e.amount), currency=e.currency, posted=e.posted)
                                 for e in data["entries"][j.journal_id]], reasons=a["reasons"],
                        currencyMismatch=a["currency_mismatch"], accountMismatch=a["party_mismatch"],
                        referenceMismatch=a["reference_mismatch"]) for j, a in assessed]
        common = {"journalReferences": [j.journal_ref for j in linked], "journalAssessments": details,
                  "legacyLedgerIds": [r.id for r in legacy],
                  "legacyRecords": [dict(id=r.id, amount=str(r.amount), currency=r.currency, entryType=r.entry_type) for r in legacy],
                  "expectedCurrency": tx.currency,
                  "expectedSenderAccountId": str(instruction.sender_account_id) if instruction else None,
                  "expectedReceiverAccountId": str(instruction.receiver_account_id) if instruction else None,
                  "accountValidation": "INSTRUCTION_LINKED" if instruction else "UNAVAILABLE_LEGACY"}
        if not linked and not legacy:
            result["MISSING_LEDGER_POSTING"] = {**common, "classification": "NO_POSTING_RECORD"}
        legacy_invalid = any(not r.amount.is_finite() or r.amount <= 0 or r.entry_type.upper() not in ("CREDIT", "DEBIT") for r in legacy)
        if len({r.entry_type.upper() for r in legacy}) > 1:
            legacy_invalid = True
        if any(d["reasons"] for d in details) or legacy_invalid or linked and legacy:
            result["INVALID_LEDGER_POSTING"] = {**common, "classification": "INVALID_OR_INCOMPLETE_POSTING",
                "legacyInvalid": legacy_invalid, "mixedRepresentations": bool(linked and legacy)}
        if any(a["currency_mismatch"] for _, a in assessed) or any(r.currency != tx.currency for r in legacy):
            result["LEDGER_CURRENCY_MISMATCH"] = {**common, "expectedCurrency": tx.currency,
                                                  "legacyCurrencies": sorted({r.currency for r in legacy})}
        if any(a["party_mismatch"] for _, a in assessed):
            result["LEDGER_ACCOUNT_MISMATCH"] = {**common, "classification": "WRONG_INSTRUCTION_ACCOUNTS"}
        unmatched = [j for j, a in assessed if a["valid"] and a["reference_mismatch"]]
        if unmatched:
            result["UNMATCHED_TRANSACTION"] = {**common, "journalReference": unmatched[0].journal_ref,
                "actualReference": unmatched[0].payment_reference, "expectedReference": tx.reference,
                "classification": "SOURCE_REFERENCE_CONFLICT"}
        safe_modern = len(valid) == len(linked) and bool(valid) and not legacy
        safe_legacy = bool(legacy) and not linked and not legacy_invalid and all(r.currency == tx.currency for r in legacy)
        posted = sum((a["debit"] for _, a in valid), Decimal(0)) if safe_modern else sum((r.amount for r in legacy), Decimal(0))
        tolerance = Decimal(policies["AMOUNT_MISMATCH"][1]["amount_tolerance_cents"]) / 100
        if (safe_modern or safe_legacy) and abs(posted - tx.amount) > tolerance:
            result["AMOUNT_MISMATCH"] = {**common, "expectedAmount": str(tx.amount), "postedAmount": str(posted),
                                        "difference": str(posted - tx.amount), "tolerance": str(tolerance),
                                        "representation": "MODERN" if safe_modern else "LEGACY"}
        for code in list(result):
            cutoff = due_at(tx, instruction, policies[code][1])
            if now < cutoff:
                del result[code]
            else:
                result[code]["cutoff"] = cutoff.isoformat()
    events = data["events"][tx.id]
    original = None
    if instruction and instruction.original_payment_id:
        oi = data["instructions_by_id"].get(instruction.original_payment_id)
        original = data["transactions"].get(oi.transaction_id) if oi else None
    if original is None:
        original = next((t for t in data["references"][tx.payment_reference] if t.id < tx.id), None)
    if original and original.id != tx.id:
        oi = data["instructions"].get(original.id)
        matching = bool(instruction and oi and instruction.sender_account_id == oi.sender_account_id
                        and instruction.receiver_account_id == oi.receiver_account_id
                        and tx.amount == original.amount and tx.currency == original.currency)
        direct = bool(instruction and oi and instruction.original_payment_id == oi.payment_id)
        blocked = any(e.event_type == "DUPLICATE_BLOCKED" for e in events)
        op, oc = posting_assessment(original, oi, data)
        dp, dc = posting_assessment(tx, instruction, data)
        if not (tx.status == "REJECTED" and not linked and not legacy):
            financial = "EXECUTION_OUTCOME_UNKNOWN"
            if oc and dc and len(op) == len(dp) == 1:
                financial = "TWO_POSTINGS_CONFIRMED"
            elif (oc and len(op) == 1 and not linked and not legacy and tx.status == "PENDING" and blocked
                  and not any(e.event_type in ("PROCESSING_STARTED", "LEDGER_POSTED", "PROCESSING_COMPLETED") for e in events)):
                financial = "SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD"
            result["DUPLICATE_TRANSACTION"] = {
                "originalReference": original.reference, "businessReference": tx.payment_reference,
                "originalBusinessReference": original.payment_reference,
                "originalPaymentId": str(oi.payment_id) if oi else None,
                "duplicatePaymentId": str(instruction.payment_id) if instruction else None,
                "classification": "SUSPECTED_DUPLICATE",
                "originalCompleted": original.status == "COMPLETED", "originalInstructionLinked": direct,
                "attributesMatch": matching, "duplicateBlocked": blocked,
                "idempotencyKeysMatch": bool(instruction and oi and instruction.idempotency_key == oi.idempotency_key),
                "financialAssessment": financial, "originalJournalReferences": op,
                "duplicateJournalReferences": dp, "rootCause": "NOT_ESTABLISHED",
                "processingEventIds": [e.id for e in events],
                "originalProcessingEventIds": [e.id for e in data["events"][original.id]]}
    if tx.status in ("PENDING", "PROCESSING"):
        config = policies["PROCESSING_TIMEOUT"][1]
        last = max(events, key=lambda e: (aware(e.created_at), e.id)) if events else None
        held = bool(last and last.event_type == "DUPLICATE_BLOCKED" and not linked and not legacy)
        waiting = bool(last and last.event_type in ("WAITING_FOR_EXTERNAL_SYSTEM", "WAITING_FOR_CLEARING"))
        activity = max([aware(tx.created_at)] + [aware(e.created_at) for e in events])
        age, idle = (now - aware(tx.created_at)).total_seconds(), (now - activity).total_seconds()
        if not held and (age >= config["max_pending_seconds"] or not waiting and idle >= config["inactivity_seconds"]):
            result["PROCESSING_TIMEOUT"] = {"status": tx.status, "lastActivityAt": activity.isoformat(),
                "lastEventId": last.id if last else None, "waitingForExternalSystem": waiting,
                "retryAttemptsObserved": sum(e.event_type in ("RETRY_SUBMITTED", "PROCESSING_RETRY_STARTED") for e in events),
                "inactivityThresholdSeconds": config["inactivity_seconds"], "maximumAgeSeconds": config["max_pending_seconds"]}
    return result


def detect(db, role, now=None):
    now = aware(now or simulation_now())
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": DETECTOR_LOCK})
    policies = load_rules(db, now)
    rows = db.execute(select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction,
        PaymentInstruction.transaction_id == Transaction.id).order_by(Transaction.id).with_for_update(of=Transaction)).all()
    data = {"transactions": {t.id: t for t, _ in rows}, "instructions": {t.id: i for t, i in rows},
            "instructions_by_id": {i.payment_id: i for _, i in rows if i},
            "references": defaultdict(list), "journals_by_tx": defaultdict(list),
            "entries": defaultdict(list), "legacy": defaultdict(list), "events": defaultdict(list),
            "accounts": {a.account_id: a for a in db.scalars(select(Account))}}
    by_reference = {t.reference: t.id for t, _ in rows}
    for tx, _ in rows:
        data["references"][tx.payment_reference].append(tx)
    for journal in db.scalars(select(LedgerJournal).order_by(LedgerJournal.journal_ref)):
        for tx_id in {journal.source_transaction_id, by_reference.get(journal.payment_reference)} - {None}:
            data["journals_by_tx"][tx_id].append(journal)
    for entry in db.scalars(select(LedgerEntry).order_by(LedgerEntry.entry_ref)):
        data["entries"][entry.journal_id].append(entry)
    for row in db.scalars(select(LedgerRecord).order_by(LedgerRecord.id)):
        data["legacy"][row.transaction_id].append(row)
    for row in db.scalars(select(ProcessingEvent).order_by(ProcessingEvent.created_at, ProcessingEvent.id)):
        data["events"][row.transaction_id].append(row)
    history = defaultdict(list)
    for case in db.scalars(select(ExceptionCase).order_by(ExceptionCase.id)):
        history[(case.transaction_id, case.exception_type)].append(case)
    observations = {(o.transaction_id, o.rule_id): o for o in db.scalars(select(DetectionObservation).where(DetectionObservation.related_transaction_id.is_(None)))}
    created = []
    for tx, instruction in rows:
        findings = evaluate(tx, instruction, data, policies, now)
        for code, (rule, config) in policies.items():
            if code == 'DUPLICATE_TRANSACTION':
                continue  # Pair observations are handled separately below.
            if not rule.enabled:
                continue
            if code in LEDGER_RULES and (tx.status != "COMPLETED" or now < due_at(tx, instruction, config)):
                continue  # Ineligible state/window is not an observed financial recovery.
            evidence = findings.get(code)
            identity = (tx.id, rule.exception_type)
            prior = history[identity]
            active = next((c for c in reversed(prior) if c.status not in TERMINAL), None)
            cursor_key = (tx.id, rule.id)
            cursor = observations.get(cursor_key)
            policy_hash = fingerprint({"version": rule.version, "configuration": config})
            recovered = bool(cursor and not cursor.defective and cursor.policy_fingerprint == policy_hash)
            if cursor is None:
                cursor = DetectionObservation(transaction_id=tx.id, rule_id=rule.id, defective=bool(evidence), observed_at=now,
                                              policy_fingerprint=policy_hash)
                db.add(cursor)
                observations[cursor_key] = cursor
            cursor.defective, cursor.observed_at = bool(evidence), now
            cursor.policy_fingerprint = policy_hash
            cursor.fingerprint = fingerprint(evidence) if evidence else None
            if evidence is None or active or prior and not recovered:
                continue
            details = {"transactionReference": tx.reference, "observedAt": now.isoformat(), **evidence,
                       "ruleCode": code, "ruleVersion": rule.version, "ruleConfiguration": config,
                       "evidenceFingerprint": cursor.fingerprint}
            if prior:
                details["recurrenceOf"] = f"CASE-{prior[-1].id:06d}"
            case = ExceptionCase(transaction_id=tx.id, rule_id=rule.id, exception_type=rule.exception_type,
                                 severity=rule.severity, status="OPEN", detection_key=f"{tx.id}:{rule.exception_type}",
                                 evidence=details, created_at=now, updated_at=now)
            if not insert_case(db, case):
                continue
            history[identity].append(case)
            db.add(ExceptionCaseAction(exception_id=case.id, action_type="DETECTED", actor=role, details=details, created_at=now))
            db.add(AuditEvent(action="EXCEPTION_DETECTED", actor=role, reference=f"CASE-{case.id:06d}", details=details, created_at=now))
            created.append(case.id)
    created.extend(detect_pairs(db, rows, data, policies['DUPLICATE_TRANSACTION'], role, now))
    db.add(AuditEvent(action="DETECTION_RUN", actor=role, reference="DETECTION", details={"createdCases": created}, created_at=now))
    db.flush()
    return created


def insert_case(db, case):
    """A competing active-key insertion rolls back only its savepoint."""
    try:
        with db.begin_nested():
            db.add(case)
            db.flush()
    except IntegrityError:
        competing = db.scalar(select(ExceptionCase).where(ExceptionCase.detection_key == case.detection_key,
                                                          ExceptionCase.status.not_in(TERMINAL)))
        if competing is None:
            raise
        return False
    return True


def case_dtos(db, transaction_id=None, schema=None):
    from shared.schema import capabilities
    schema = schema or capabilities(db)
    query = select(ExceptionCase, Transaction.reference).join(Transaction, Transaction.id == ExceptionCase.transaction_id)
    if not schema['cases']:
        query = query.options(defer(ExceptionCase.related_transaction_id))
    if transaction_id is not None:
        query = query.where(or_(ExceptionCase.transaction_id == transaction_id, ExceptionCase.related_transaction_id == transaction_id)
                            if schema['cases'] else ExceptionCase.transaction_id == transaction_id)
    refs = dict(db.execute(select(Transaction.id, Transaction.reference)).all())
    return [dict(id=f"CASE-{c.id:06d}", transactionId=reference, exceptionType=c.exception_type,
                 relatedTransactionId=refs.get(c.related_transaction_id if schema['cases'] else None) or (c.evidence or {}).get('originalReference'),
                 severity=c.severity, status=c.status, evidence=c.evidence or {}, createdAt=aware(c.created_at),
                 updatedAt=aware(c.updated_at), resolvedAt=aware(c.resolved_at), resolutionSummary=c.resolution_summary)
            for c, reference in db.execute(query.order_by(ExceptionCase.id.desc()))]


def pair_finding(a, ai, b, bi, data, config):
    matching = bool(ai and bi and ai.sender_account_id == bi.sender_account_id and ai.receiver_account_id == bi.receiver_account_id
                    and a.amount == b.amount and a.currency == b.currency)
    direct = bool(ai and bi and (bi.original_payment_id == ai.payment_id or ai.original_payment_id == bi.payment_id))
    elapsed = abs((aware(b.created_at) - aware(a.created_at)).total_seconds())
    shared = a.payment_reference == b.payment_reference
    similar = matching and a.status == b.status == 'COMPLETED' and elapsed <= config['similarity_window_seconds']
    if not (direct or shared or similar) or b.status == 'REJECTED' and not data['journals_by_tx'][b.id] and not data['legacy'][b.id]:
        return None
    op, oc = posting_assessment(a, ai, data)
    dp, dc = posting_assessment(b, bi, data)
    events = data['events'][b.id]
    blocked = any(e.event_type == 'DUPLICATE_BLOCKED' for e in events)
    outcome = 'EXECUTION_OUTCOME_UNKNOWN'
    if oc and dc and len(op) == len(dp) == 1 and op != dp:
        outcome = 'TWO_POSTINGS_CONFIRMED'
    elif (oc and len(op) == 1 and not data['journals_by_tx'][b.id] and not data['legacy'][b.id]
          and b.status in {'PENDING', 'HELD'} and blocked
          and not any(e.event_type in {'PROCESSING_STARTED', 'LEDGER_POSTED', 'PROCESSING_COMPLETED'} for e in events)):
        outcome = 'SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD'
    return dict(originalReference=a.reference, transactionReference=b.reference, businessReference=b.payment_reference,
        originalBusinessReference=a.payment_reference, originalPaymentId=str(ai.payment_id) if ai else None,
        duplicatePaymentId=str(bi.payment_id) if bi else None, originalCompleted=a.status == 'COMPLETED',
        originalInstructionLinked=direct, attributesMatch=matching, timeDifferenceSeconds=elapsed, sharedReference=shared,
        duplicateBlocked=blocked, classification='SUSPECTED_DUPLICATE', rootCause='NOT_ESTABLISHED',
        idempotencyKeysMatch=bool(ai and bi and ai.idempotency_key == bi.idempotency_key),
        originalJournalReferences=op, duplicateJournalReferences=dp, financialAssessment=outcome,
        processingEventIds=[e.id for e in events], originalProcessingEventIds=[e.id for e in data['events'][a.id]])


def detect_pairs(db, rows, data, policy, role, now):
    rule, config = policy
    if not rule.enabled:
        return []
    rows = sorted(rows, key=lambda row: row[0].id)
    cases = db.scalars(select(ExceptionCase).where(ExceptionCase.exception_type == rule.exception_type).order_by(ExceptionCase.id)).all()
    cursors = {(o.transaction_id, o.related_transaction_id): o for o in db.scalars(select(DetectionObservation).where(
        DetectionObservation.rule_id == rule.id, DetectionObservation.related_transaction_id.is_not(None)))}
    policy_hash, created = fingerprint({'version': rule.version, 'configuration': config}), []
    for index, (a, ai) in enumerate(rows):
        for b, bi in rows[index + 1:]:
            evidence = pair_finding(a, ai, b, bi, data, config)
            prior = [c for c in cases if c.transaction_id == b.id and (c.related_transaction_id == a.id or
                c.related_transaction_id is None and ((c.evidence or {}).get('originalReference') == a.reference or
                    ai and bi and bi.original_payment_id == ai.payment_id))]
            cursor = cursors.get((b.id, a.id))
            if evidence is None and not prior and cursor is None:
                continue
            recovered = bool(cursor and not cursor.defective and cursor.policy_fingerprint == policy_hash)
            if cursor is None:
                cursor = DetectionObservation(transaction_id=b.id, related_transaction_id=a.id, rule_id=rule.id,
                    defective=bool(evidence), policy_fingerprint=policy_hash, observed_at=now)
                db.add(cursor)
                cursors[(b.id, a.id)] = cursor
            cursor.defective, cursor.observed_at, cursor.policy_fingerprint = bool(evidence), now, policy_hash
            cursor.fingerprint = fingerprint(evidence) if evidence else None
            if evidence is None or any(c.status not in TERMINAL for c in prior) or prior and not recovered:
                continue
            details = {**evidence, 'observedAt': now.isoformat(), 'ruleCode': rule.code, 'ruleVersion': rule.version,
                       'ruleConfiguration': config, 'evidenceFingerprint': cursor.fingerprint}
            if prior:
                details['recurrenceOf'] = f'CASE-{prior[-1].id:06d}'
            case = ExceptionCase(transaction_id=b.id, related_transaction_id=a.id, rule_id=rule.id,
                exception_type=rule.exception_type, severity=rule.severity, status='OPEN',
                detection_key=f'DUPLICATE_TRANSACTION:{a.id}:{b.id}', evidence=details, created_at=now, updated_at=now)
            if insert_case(db, case):
                cases.append(case)
                created.append(case.id)
                db.add(ExceptionCaseAction(exception_id=case.id, action_type='DETECTED', actor=role, details=details, created_at=now))
                db.add(AuditEvent(action='EXCEPTION_DETECTED', actor=role, reference=f'CASE-{case.id:06d}', details=details, created_at=now))
    return created
