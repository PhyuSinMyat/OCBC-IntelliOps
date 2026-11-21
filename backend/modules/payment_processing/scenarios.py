"""Guarded deterministic simulation, reusing ordinary payment and ledger execution."""
import hashlib
import json
import os
from datetime import timedelta
from decimal import Decimal
from uuid import uuid4
from sqlalchemy import select, text
from modules.core_banking.models import Account, LedgerJournal, LedgerEntry
from modules.core_banking.service import account_balance
from modules.intelliops.models import DetectionRule
from modules.intelliops.rules import BY_CODE, validate_configuration
from .models import Transaction, ProcessingEvent, PaymentInstruction, PaymentRequestHistory, ExceptionBatch, ExceptionBatchItem
from .schemas import PaymentRequest
from .service import create_payment, record_request, event, PaymentError, simulation_now, payment_dtos

A, B, C = 'CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS'

OTHER_VARIANTS = {
    'PROCESSING_FAILURE': {
        'PROCESSOR_UNAVAILABLE', 'CLEARING_REJECTION', 'ACCOUNT_RESTRICTED_DURING_PROCESSING'},
    'MISSING_LEDGER': {
        'POSTING_EVENT_LOST', 'LEDGER_TRANSACTION_ROLLBACK', 'LEDGER_CONSUMER_DEAD_LETTER'},
    'AMOUNT_MISMATCH': {
        'FEE_INCORRECTLY_NETTED', 'PARTIAL_SETTLEMENT', 'DECIMAL_SCALING_ERROR'},
    'UNMATCHED': {
        'REFERENCE_TYPO', 'BATCH_CORRELATION_SHIFT', 'MANUAL_JOURNAL_MISLINK'},
}


def instruction_execution(db, anchor_id, lookup=None):
    query = select(PaymentInstruction).join(PaymentRequestHistory, PaymentRequestHistory.payment_id == PaymentInstruction.payment_id).join(
        Transaction, Transaction.id == PaymentInstruction.transaction_id).where(
        PaymentRequestHistory.business_instruction_id == anchor_id, Transaction.status == 'COMPLETED')
    return lookup(query) if lookup else db.scalar(query)


def fault_guard(request, role):
    allowed = {v.strip() for v in os.getenv('INTELLIOPS_SYNTHETIC_ACCOUNT_REFS', '').split(',') if v.strip()}
    if (role != 'ANALYST' or os.getenv('INTELLIOPS_ENABLE_RETRY_FAULT') != 'true'
            or os.getenv('INTELLIOPS_ENVIRONMENT') not in {'development', 'test'}
            or not {request.sender_account_ref, request.receiver_account_ref} <= allowed):
        raise PaymentError('Retry fault requires explicit development/test enablement and allowlisted synthetic accounts.', 403)


def generate_duplicate(db, request, role):
    if role != 'ANALYST':
        raise PaymentError('Only ANALYST may generate scenarios.', 403)
    if request.duplicate_scenario == B:
        fault_guard(request, role)
    if db.bind.dialect.name == 'postgresql':
        key = int.from_bytes(hashlib.sha256(request.run_key.encode()).digest()[:8], 'big', signed=True)
        db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': key})
    payload = request.model_dump(exclude={'run_key', 'idempotency_key'}, mode='json')
    payload['amount'] = str(request.amount.quantize(Decimal('0.01')))
    signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    batch = db.scalar(select(ExceptionBatch).where(ExceptionBatch.run_key == request.run_key).with_for_update())
    if batch:
        if batch.input_fingerprint != signature:
            raise PaymentError('Run key already used with different inputs.', 409)
        return batch
    now = simulation_now()
    accounts = db.scalars(select(Account).where(Account.account_ref.in_([request.sender_account_ref, request.receiver_account_ref]))
                         .order_by(Account.account_id).with_for_update()).all()
    refs = {a.account_ref: a for a in accounts}
    sender, receiver = refs.get(request.sender_account_ref), refs.get(request.receiver_account_ref)
    if (not sender or not receiver or sender == receiver or sender.status != 'Active' or receiver.status != 'Active'
            or sender.currency != receiver.currency or request.currency and request.currency != sender.currency):
        raise PaymentError('Choose different Active accounts in the same currency.')
    if account_balance(db, sender.account_id)['current_balance'] < request.amount * (1 if request.duplicate_scenario == A else 2):
        raise PaymentError('Insufficient funds for all scenario postings.')
    rule = db.scalar(select(DetectionRule).where(DetectionRule.exception_type == 'Duplicate Transaction'))
    window = validate_configuration(BY_CODE['DUPLICATE_TRANSACTION'], rule)['similarity_window_seconds'] if rule else 120
    spacing = min(5, window / 2) if request.duplicate_scenario == C else 5
    delay, confirmation = min(1, spacing / 3), min(2, spacing * 2 / 3)
    batch = ExceptionBatch(run_key=request.run_key, input_fingerprint=signature, requested_scenarios=['DUPLICATE'], count_per_type=1,
        private_metadata={'scenario': request.duplicate_scenario, 'expected_root_cause': {
            A: 'CUSTOMER_DOUBLE_SUBMISSION', B: 'INSTRUCTION_REPLAY_LOOKUP_FAILURE', C: 'INDEPENDENT_AUTHORIZATION'
        }[request.duplicate_scenario]}, status='PROCESSING', created_by=role, created_at=now)
    db.add(batch)
    db.flush()
    receipts, payments = [], []
    anchor = None
    correlation = uuid4()

    def evidence(tx, receipt, kind, seconds, **facts):
        origin = facts.pop('origin', receipt.origin)
        if kind == 'LEDGER_POSTING_CONFIRMED':
            facts['journal_reference'] = db.scalar(select(LedgerJournal.journal_ref).where(LedgerJournal.normal_transaction_id == tx.id))
        event(db, tx, kind, 'COMPLETED' if kind == 'PAYMENT_AUTHORIZED' else tx.status,
            dict(source_component='payment_simulator', request_id=str(receipt.request_id), intent_id=str(receipt.business_instruction_id),
                 origin=origin, **facts), now + timedelta(seconds=seconds), request_id=receipt.request_id)

    def accept(tx, instruction, index):
        nonlocal anchor
        shared = bool(index and request.duplicate_scenario != C)
        if shared:
            instruction.original_payment_id = anchor.payment_id
            tx.payment_reference = payments[0].payment_reference
        authorization = uuid4() if request.duplicate_scenario == C else None
        receipt = record_request(db, instruction, f'run:{batch.batch_id}:{index}', now + timedelta(seconds=index * spacing),
            anchor=anchor if shared else instruction, origin='SYSTEM' if index and request.duplicate_scenario == B else 'CUSTOMER',
            retry=receipts[0] if index and request.duplicate_scenario == B else None, authorization=authorization, correlation=correlation)
        anchor = anchor or instruction
        receipts.append(receipt)
        payments.append(tx)
        at = index * spacing
        if authorization:
            evidence(tx, receipt, 'PAYMENT_AUTHORIZED', at, authorization_id=str(authorization), authorized=True,
                     sender_account_ref=sender.account_ref, receiver_account_ref=receiver.account_ref, amount=str(request.amount), currency=sender.currency)
        if receipt.origin == 'CUSTOMER':
            evidence(tx, receipt, 'CLIENT_SUBMISSION', at, trigger='USER_SUBMIT', submission_id=str(receipt.request_id))
        else:
            evidence(tx, receipt, 'RETRY_SUBMITTED', at, trigger='AUTOMATIC_RETRY', correlation_id=str(correlation), original_payment_ref=payments[0].reference)
        evidence(tx, receipt, 'PAYMENT_REQUEST_RECEIVED', at + min(.1, delay / 2))
        return receipt

    def execute(index, callback=None):
        payment = PaymentRequest(sender_account_ref=sender.account_ref, receiver_account_ref=receiver.account_ref,
            amount=request.amount, currency=sender.currency, idempotency_key=f'exec:{batch.batch_id}:{index}')
        tx, _ = create_payment(db, payment, role, now=now + timedelta(seconds=index * spacing + delay),
                              _on_accepted=callback or (lambda tx, instruction: accept(tx, instruction, index)))
        db.flush()
        evidence(tx, receipts[-1], 'LEDGER_POSTING_CONFIRMED', index * spacing + confirmation)
        return tx

    first = execute(0)
    if request.duplicate_scenario == A:
        evidence(first, receipts[0], 'CLIENT_CONFIRMATION_DELAYED', 3)
        if instruction_execution(db, anchor.payment_id) is None:
            raise PaymentError('Original execution cannot be verified.', 409)
        suffix = uuid4().hex[:16].upper()
        second = Transaction(reference=f'TXN-{suffix}', payment_reference=first.payment_reference, amount=request.amount,
            currency=sender.currency, status='HELD', created_at=now + timedelta(seconds=5))
        db.add(second)
        db.flush()
        extension = PaymentInstruction(transaction_id=second.id, sender_account_id=sender.account_id, receiver_account_id=receiver.account_id,
            idempotency_key=f'exec:{batch.batch_id}:1', request_fingerprint=signature, original_payment_id=anchor.payment_id,
            scenario_code='NORMAL', failure_code='DUPLICATE_REFERENCE', failure_description='Instruction replay control held execution before posting.')
        db.add(extension)
        db.flush()
        receipt = accept(second, extension, 1)
        evidence(second, receipt, 'DUPLICATE_CONTROL_MATCH', 6, matched_payment_ref=first.reference)
        evidence(second, receipt, 'DUPLICATE_BLOCKED', 7, posting_started=False)
    elif request.duplicate_scenario == B:
        evidence(first, receipts[0], 'ACK_TIMEOUT', 3, origin='SYSTEM', correlation_id=str(correlation))
        evidence(first, receipts[0], 'RETRY_SCHEDULED', 4, origin='SYSTEM', correlation_id=str(correlation))
        if instruction_execution(db, anchor.payment_id) is None:
            raise PaymentError('Original execution is not observable.', 409)
        # The guarded adapter really returns a false miss. It is private to this
        # operation and does not bypass execution-key or ledger constraints.
        if instruction_execution(db, anchor.payment_id, lookup=lambda query: None) is not None:
            raise PaymentError('Synthetic lookup did not return a miss.', 409)
        def retry_accept(tx, instruction):
            receipt = accept(tx, instruction, 1)
            evidence(tx, receipt, 'IDEMPOTENCY_CHECK_FAILED', 5.2, correlation_id=str(correlation),
                original_payment_ref=first.reference, lookup_result='MISS', authoritative_execution_present=True)
            return receipt
        execute(1, retry_accept)
    else:
        execute(1)
    for index, tx in enumerate(payments):
        db.add(ExceptionBatchItem(batch_id=batch.batch_id, transaction_id=tx.id, scenario_code='DUPLICATE', sequence=index))
    batch.status, batch.completed_at = 'COMPLETED', now + timedelta(seconds=8)
    db.flush()
    return batch


def generate_exception_variant(db, request, role):
    """Create one evidence-rich non-duplicate scenario through ordinary execution."""
    if role != 'ANALYST':
        raise PaymentError('Only ANALYST may generate scenarios.', 403)
    if request.scenario_code not in OTHER_VARIANTS or request.scenario_variant not in OTHER_VARIANTS[request.scenario_code]:
        raise PaymentError('Scenario variant does not match its exception type.')
    if db.bind.dialect.name == 'postgresql':
        key = int.from_bytes(hashlib.sha256(request.run_key.encode()).digest()[:8], 'big', signed=True)
        db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': key})
    payload = request.model_dump(exclude={'run_key', 'idempotency_key'}, mode='json')
    payload['amount'] = str(request.amount.quantize(Decimal('0.01')))
    signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    batch = db.scalar(select(ExceptionBatch).where(ExceptionBatch.run_key == request.run_key).with_for_update())
    if batch:
        if batch.input_fingerprint != signature:
            raise PaymentError('Run key already used with different inputs.', 409)
        return batch

    now = simulation_now()
    variant = request.scenario_variant
    batch = ExceptionBatch(run_key=request.run_key, input_fingerprint=signature,
        requested_scenarios=[request.scenario_code], count_per_type=1,
        private_metadata={'scenario_variant': variant}, status='PROCESSING', created_by=role, created_at=now)
    db.add(batch)
    db.flush()
    payment = PaymentRequest(sender_account_ref=request.sender_account_ref, receiver_account_ref=request.receiver_account_ref,
        amount=request.amount, currency=request.currency, idempotency_key=f'exec:{batch.batch_id}:0')
    tx, _ = create_payment(db, payment, role, request.scenario_code, now)
    instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == tx.id))
    receipt = db.scalar(select(PaymentRequestHistory).where(PaymentRequestHistory.payment_id == instruction.payment_id)
                        .order_by(PaymentRequestHistory.received_at))

    def source_event(kind, seconds, component, **facts):
        event(db, tx, kind, tx.status, dict(source_component=component, request_id=str(receipt.request_id),
            intent_id=str(receipt.business_instruction_id), origin=receipt.origin, **facts),
            now + timedelta(seconds=seconds), request_id=receipt.request_id)

    existing = {row.event_type: row for row in db.scalars(select(ProcessingEvent).where(
        ProcessingEvent.transaction_id == tx.id).order_by(ProcessingEvent.id))}

    if request.scenario_code == 'PROCESSING_FAILURE':
        details = {
            'PROCESSOR_UNAVAILABLE': ('PROCESSOR_CONNECTION_FAILED', 'PROCESSOR_UNAVAILABLE', 'The downstream payment processor was unavailable.'),
            'CLEARING_REJECTION': ('CLEARING_REJECTED', 'CLEARING_REJECTED', 'The clearing network rejected routing or beneficiary data.'),
            'ACCOUNT_RESTRICTED_DURING_PROCESSING': ('ACCOUNT_STATUS_CHANGED', 'ACCOUNT_RESTRICTED', 'The sender account became restricted after validation.'),
        }
        kind, code, message = details[variant]
        if variant == 'CLEARING_REJECTION':
            source_event('CLEARING_SUBMITTED', 1, 'payment_gateway')
        source_event(kind, 2, 'payment_gateway' if variant != 'ACCOUNT_RESTRICTED_DURING_PROCESSING' else 'core_banking')
        instruction.failure_code, instruction.failure_description = code, message
        failed = existing['PROCESSING_FAILED']
        failed.error_code, failed.details, failed.created_at = code, message, now + timedelta(seconds=3)

    elif request.scenario_code == 'MISSING_LEDGER':
        if variant == 'POSTING_EVENT_LOST':
            source_event('LEDGER_EVENT_PUBLICATION_FAILED', 2, 'payment_processor')
        elif variant == 'LEDGER_TRANSACTION_ROLLBACK':
            source_event('LEDGER_POSTING_STARTED', 1, 'ledger', posting_started=True)
            source_event('LEDGER_TRANSACTION_ROLLED_BACK', 2, 'ledger', posting_started=True)
        else:
            source_event('LEDGER_EVENT_PUBLISHED', 1, 'payment_processor')
            source_event('LEDGER_CONSUMER_RETRY', 1.5, 'ledger')
            source_event('LEDGER_MESSAGE_DEAD_LETTERED', 2, 'ledger')
        instruction.completed_at = now + timedelta(seconds=3)
        existing['PROCESSING_COMPLETED'].created_at = now + timedelta(seconds=3)

    elif request.scenario_code == 'AMOUNT_MISMATCH':
        journal = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
        entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == journal.journal_id)).all()
        amount = request.amount - Decimal('0.01')
        if variant == 'PARTIAL_SETTLEMENT':
            amount = max(Decimal('0.01'), (request.amount / 2).quantize(Decimal('0.01')))
        elif variant == 'DECIMAL_SCALING_ERROR':
            amount = max(Decimal('0.01'), (request.amount / 100).quantize(Decimal('0.01')))
        for entry in entries:
            entry.amount = amount
        kind = {'FEE_INCORRECTLY_NETTED': 'FEE_APPLIED_TO_PRINCIPAL',
                'PARTIAL_SETTLEMENT': 'PARTIAL_SETTLEMENT_APPLIED',
                'DECIMAL_SCALING_ERROR': 'AMOUNT_SCALE_TRANSFORMED'}[variant]
        source_event(kind, 1, 'payment_processor', amount=str(amount), currency=tx.currency)
        journal.posted_at = now + timedelta(seconds=2)
        existing['LEDGER_POSTED'].created_at = now + timedelta(seconds=2)
        instruction.completed_at = now + timedelta(seconds=3)
        existing['PROCESSING_COMPLETED'].created_at = now + timedelta(seconds=3)

    else:
        journal = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
        prefixes = {'REFERENCE_TYPO': 'TYPO', 'BATCH_CORRELATION_SHIFT': 'BATCH-SHIFT',
                    'MANUAL_JOURNAL_MISLINK': 'MANUAL-LINK'}
        journal.payment_reference = f'{prefixes[variant]}-{tx.reference}'
        kind = {'REFERENCE_TYPO': 'REFERENCE_MAPPING_APPLIED',
                'BATCH_CORRELATION_SHIFT': 'SETTLEMENT_BATCH_CORRELATED',
                'MANUAL_JOURNAL_MISLINK': 'MANUAL_JOURNAL_SUBMITTED'}[variant]
        source_event(kind, 1, 'ledger', journal_reference=journal.journal_ref)
        journal.posted_at = now + timedelta(seconds=2)
        existing['LEDGER_POSTED'].created_at = now + timedelta(seconds=2)
        instruction.completed_at = now + timedelta(seconds=3)
        existing['PROCESSING_COMPLETED'].created_at = now + timedelta(seconds=3)

    db.add(ExceptionBatchItem(batch_id=batch.batch_id, transaction_id=tx.id,
                              scenario_code=request.scenario_code, sequence=0))
    batch.status, batch.completed_at = 'COMPLETED', now + timedelta(seconds=4)
    db.flush()
    return batch


def run_result(db, batch):
    rows = db.execute(select(Transaction, PaymentInstruction).join(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)
        .join(ExceptionBatchItem, ExceptionBatchItem.transaction_id == Transaction.id).where(ExceptionBatchItem.batch_id == batch.batch_id)
        .order_by(ExceptionBatchItem.sequence)).all()
    payments = payment_dtos(db, rows)
    journals = db.scalars(select(LedgerJournal).where(LedgerJournal.source_transaction_id.in_([t.id for t, _ in rows]), LedgerJournal.status == 'Posted')).all()
    return dict(**payments[0], runId=str(batch.batch_id), payments=payments, paymentReferences=[p['id'] for p in payments],
        requestIds=[r['requestId'] for p in payments for r in p['requests']],
        instructionReferences=sorted({r['instructionReference'] for p in payments for r in p['requests']}),
        journalReferences=[j.journal_ref for j in journals], attemptCount=len(payments), postingCount=len(journals), timestamp=batch.completed_at)
