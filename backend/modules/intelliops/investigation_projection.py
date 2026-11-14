"""Typed source projection and a separate, closed model-input boundary."""
import json
import re
from datetime import datetime
from decimal import Decimal
from pydantic import ValidationError
from .investigation_schemas import SourceEventData

PRIVATE_VALUE = re.compile(r'CUSTOMER_DOUBLE_CLICK|AUTOMATIC_RETRY_FAILURE|LEGITIMATE_REPEATED_PAYMENTS|expected[_ -]|private[_ -]?metadata|ground[_ -]?truth|hidden[_ -]?answer|scenario[_ -][ABC](?:\b|_)', re.I)


def parse_source(event):
    raw = event.details
    if not raw:
        return {}, dict(status='ABSENT', errors=[], omittedFieldCount=0)
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        # Historical human-readable descriptions are not structured source facts.
        status = 'INVALID' if isinstance(raw, str) and raw.lstrip().startswith(('{', '[')) else 'UNSTRUCTURED'
        return {}, dict(status=status, errors=['invalid_json'] if status == 'INVALID' else [], omittedFieldCount=0)
    if not isinstance(payload, dict):
        return {}, dict(status='INVALID', errors=['object_required'], omittedFieldCount=0)
    result, errors = {}, []
    known = SourceEventData.model_fields
    for key, value in payload.items():
        if key not in known:
            continue
        if value is None:
            continue
        try:
            if isinstance(value, str) and PRIVATE_VALUE.search(value):
                raise ValueError()
            result[key] = SourceEventData.model_validate({key: value}).model_dump(exclude_none=True)[key]
        except (ValidationError, ValueError, KeyError):
            errors.append('invalid_' + key)  # Never echo rejected values or private field names.
    omitted = len(set(payload) - set(known))
    status = 'PARTIAL' if errors and result else 'INVALID' if errors else 'VALID' if result else 'UNSUPPORTED'
    return result, dict(status=status, errors=errors, omittedFieldCount=omitted)


def pick(record, fields):
    return {key: record[key] for key in fields if key in record}


def model_evidence(evidence):
    """Never send raw descriptions, raw detection dictionaries or batch metadata.

    Build every collection explicitly. Analyst snapshots remain compatible and separate.
    """
    s = evidence['snapshot']
    payment_fields = ('id', 'paymentId', 'senderId', 'receiverId', 'amountCents', 'currency', 'status',
                      'createdAt', 'completedAt', 'businessReference', 'originalPaymentId')
    safe = dict(caseRecord=pick(s['caseRecord'], ('id', 'transactionId', 'relatedTransactionId', 'exceptionType', 'severity', 'status', 'createdAt')),
        original=pick(s['original'], payment_fields) if s['original'] else None,
        duplicate=pick(s['duplicate'], payment_fields) if s['duplicate'] else None,
        linkConflict=s['linkConflict'],
        accounts=[pick(r, ('id', 'currency')) for r in s['accounts']],
        journals=[pick(r, ('id', 'paymentId', 'sourcePaymentId', 'status', 'currency', 'postedAt')) for r in s['journals']],
        entries=[pick(r, ('id', 'journalId', 'accountId', 'side', 'amountCents', 'currency', 'posted')) for r in s['entries']],
        instructions=[pick(r, ('id', 'transactionReference', 'idempotencyKeyHash')) for r in s['instructions']],
        requests=[pick(r, ('id', 'paymentId', 'paymentReference', 'businessInstructionId', 'origin', 'retryOfRequestId',
            'idempotencyKeyHash', 'authorizationId', 'correlationId', 'receivedAt', 'paymentStatus', 'outcome', 'outcomeAvailability',
            'integrityValid', 'issues', 'retryValid', 'authorizationValid')) for r in s.get('requests', [])],
        legacyPostings=[pick(r, ('id', 'amount', 'currency')) for r in s['legacyPostings']], events=[])
    for event in s['events']:
        row = pick(event, ('id', 'paymentId', 'requestId', 'status', 'occurredAt', 'correlationId', 'relationshipValid'))
        row['sourceValidation'] = pick(event.get('sourceValidation', {}), ('status', 'errors', 'omittedFieldCount'))
        kind = event['eventType']
        operational = bool(re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', kind) and not PRIVATE_VALUE.search(kind)
            and not re.search(r'ROOT_CAUSE|DIAGNOSIS|RECOMMENDED_ACTION|SCENARIO', kind))
        row['eventType'] = kind if operational else 'UNRECOGNIZED_EVENT'
        # UNSTRUCTURED means there are no parsed payload facts, not missing facts to infer.
        payload = pick(event.get('sourceData', {}), SourceEventData.model_fields)
        payload = {k: v for k, v in payload.items() if not isinstance(v, str) or not PRIVATE_VALUE.search(v)}
        try:
            parsed = SourceEventData.model_validate(payload).model_dump(exclude_none=True)
        except ValidationError:
            parsed = {}
        row['sourceData'] = parsed if operational and row['sourceValidation'].get('status') in {'VALID', 'PARTIAL'} else {}
        safe['events'].append(row)
    # Exact, non-causal display units derived from the existing source cents.
    for record in [safe['original'], safe['duplicate'], *safe['entries']]:
        if record is not None:
            record['amountMajor'] = format(Decimal(record['amountCents']) / 100, '.2f')
    ordered = sorted(s.get('requests', []), key=lambda r: r['receivedAt'])
    safe['requestChronology'] = []
    for prior, later in zip(ordered, ordered[1:]):
        delta = datetime.fromisoformat(later['receivedAt']) - datetime.fromisoformat(prior['receivedAt'])
        safe['requestChronology'].append(dict(earlierRequestId=prior['id'], laterRequestId=later['id'],
            receivedIntervalSeconds=format(delta.total_seconds(), '.6f')))
    return dict(snapshot=safe, financial_verification=financial_verification(evidence),
        evidence_references=evidence['evidence_references'],
        retrieved_at=evidence.get('retrieved_at'))


def financial_verification(evidence):
    """Accounting facts only. No cause, relationship verdict, action or intent-derived excess."""
    assessment = evidence['verified_assessment']
    execution_fields = ('payment_ref', 'execution', 'journals', 'valid_journals', 'payment_status', 'processing_state', 'reason')
    impact = evidence.get('financial_impact', {})
    totals = pick(impact, ('completedPaymentCount', 'confirmedPostedJournalCount', 'validDebitTotals', 'validCreditTotals',
        'accountMovements', 'senderFinancialMovement', 'receiverFinancialMovement', 'journalValidation', 'requestHistoryComplete',
        'expectedAmount', 'postedAmount', 'difference', 'absoluteDifference', 'tolerance'))
    movement_fields = ('accountReference', 'currency', 'debit', 'credit', 'net')
    totals['accountMovements'] = [pick(r, movement_fields) for r in impact.get('accountMovements', [])]
    for side in ('senderFinancialMovement', 'receiverFinancialMovement'):
        totals[side] = pick(impact[side], movement_fields) if impact.get(side) else None
    totals['journalValidation'] = [pick(r, ('journalReference', 'valid', 'status', 'currency', 'debitTotal', 'creditTotal', 'reasons')) for r in impact.get('journalValidation', [])]
    return dict(classification=assessment['financial_classification'], original=pick(assessment['original'], execution_fields),
        duplicate=pick(assessment['duplicate'], execution_fields), **totals)
