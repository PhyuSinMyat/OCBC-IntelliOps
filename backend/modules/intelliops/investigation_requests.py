"""Read-only request provenance checks, restricted to the selected payment pair."""
import hashlib
from decimal import Decimal, InvalidOperation
from sqlalchemy import select
from modules.payment_processing.models import PaymentRequestHistory
from modules.payment_processing.service import aware


def request_evidence(db, payments, instructions, accounts, events):
    by_instruction = {i.payment_id: (p, i) for p, i in zip(payments, instructions) if i}
    rows = db.scalars(select(PaymentRequestHistory).where(PaymentRequestHistory.payment_id.in_(by_instruction))
        .order_by(PaymentRequestHistory.received_at, PaymentRequestHistory.request_id).limit(501)).all()
    if len(rows) > 500:
        from .service import CaseError
        raise CaseError('Request evidence exceeds the bounded investigation scope.', 422)
    by_id = {str(r.request_id): r for r in rows}
    dtos, uncertainty = [], []
    def details(pair):
        p, i = pair
        return i.sender_account_id, i.receiver_account_id, p.amount, p.currency
    for r in rows:
        p, instruction = by_instruction[r.payment_id]
        anchor = by_instruction.get(r.business_instruction_id)
        issues = []
        if anchor is None or details(anchor) != details((p, instruction)):
            issues.append('instruction_anchor_mismatch')
        if r.origin not in {'CUSTOMER', 'SYSTEM'}:
            issues.append('invalid_request_origin')
        retry = by_id.get(str(r.retry_of_request_id)) if r.retry_of_request_id else None
        retry_valid = False
        if r.retry_of_request_id:
            retry_valid = bool(retry and retry is not r and r.origin == 'SYSTEM'
                and retry.business_instruction_id == r.business_instruction_id
                and aware(retry.received_at) < aware(r.received_at)
                and retry.correlation_id == r.correlation_id and r.correlation_id)
            if not retry_valid:
                issues.append('retry_link_mismatch')
        if instruction.original_payment_id and instruction.original_payment_id != r.business_instruction_id:
            issues.append('original_instruction_mismatch')
        dto = dict(id=str(r.request_id), paymentId=str(r.payment_id), paymentReference=p.reference,
            businessInstructionId=str(r.business_instruction_id), origin=r.origin,
            retryOfRequestId=str(r.retry_of_request_id) if r.retry_of_request_id else None,
            idempotencyKeyHash=hashlib.sha256(r.submitted_idempotency_key.encode()).hexdigest(),
            authorizationId=str(r.authorization_id) if r.authorization_id else None,
            correlationId=str(r.correlation_id) if r.correlation_id else None,
            receivedAt=aware(r.received_at).isoformat(), paymentStatus=p.status.title(),
            outcome=None, outcomeAvailability='NOT_RECORDED', retryValid=retry_valid,
            authorizationValid=False, issues=issues, integrityValid=not issues)
        dtos.append(dto)
    dto_by_id = {r['id']: r for r in dtos}
    for event in events:
        payload = event['sourceData']
        request_id = event.get('requestId')
        request = dto_by_id.get(request_id)
        valid = event['sourceValidation']['status'] not in {'INVALID', 'PARTIAL'}
        if request_id:
            valid = valid and bool(request and request['integrityValid'] and request['paymentReference'] == event['paymentId'])
        elif payload.get('request_id'):
            valid = False  # JSON cannot invent a missing persisted FK.
        if request:
            if payload.get('request_id') not in (None, request_id) or payload.get('intent_id') not in (None, request['businessInstructionId']):
                valid = False
            if payload.get('correlation_id') not in (None, request['correlationId']):
                valid = False
            # System timeout/control events on an original customer request can have SYSTEM origin.
            if event['eventType'] in {'CLIENT_SUBMISSION', 'RETRY_SUBMITTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_REQUEST_RECEIVED'}:
                if payload.get('origin') not in (None, request['origin']):
                    valid = False
            if payload.get('retry_of_request_id') not in (None, request['retryOfRequestId']):
                valid = False
        if event['eventType'] == 'PAYMENT_AUTHORIZED':
            valid = valid and bool(request and request['origin'] == 'CUSTOMER' and request['authorizationId']
                and request['authorizationId'] == payload.get('authorization_id') and payload.get('authorized') is True
                and request['businessInstructionId'] == request['paymentId'] == payload.get('intent_id')
                and not request['retryOfRequestId'])
            if request:
                pair = by_instruction[by_id[request_id].payment_id]
                p, instruction = pair
                sender = accounts.get(instruction.sender_account_id)
                receiver = accounts.get(instruction.receiver_account_id)
                expected = {'sender_account_ref': sender.account_ref if sender else None,
                    'receiver_account_ref': receiver.account_ref if receiver else None, 'currency': p.currency}
                valid = valid and sender is not None and receiver is not None
                valid = valid and all(payload.get(k) == value for k, value in expected.items())
                try:
                    valid = valid and Decimal(payload.get('amount', 'NaN')) == p.amount
                except (InvalidOperation, TypeError):
                    valid = False
                request['authorizationValid'] = valid
        if event['eventType'] == 'RETRY_SUBMITTED':
            valid = valid and bool(request and request['retryValid'])
        event['relationshipValid'] = bool(valid)
        if not valid and event['sourceData']:
            uncertainty.append('Event ' + event['id'] + ' has invalid or conflicting operational relationships.')
    for request in dtos:
        authorizations = [e for e in events if e['eventType'] == 'PAYMENT_AUTHORIZED' and e.get('requestId') == request['id']]
        if request['authorizationId'] and len(authorizations) != 1:
            request['authorizationValid'] = False
            for event in authorizations:
                event['relationshipValid'] = False
        if request['authorizationId'] and not request['authorizationValid']:
            request['issues'].append('authorization_evidence_unverified')
            request['integrityValid'] = False
        if request['issues']:
            uncertainty.append('Request ' + request['id'] + ' has unresolved integrity checks: ' + ', '.join(request['issues']) + '.')
    if len({r['paymentReference'] for r in dtos}) < len(payments):
        uncertainty.append('Request history is missing for one or more selected payments.')
    return dtos, uncertainty
