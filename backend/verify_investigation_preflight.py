"""Read-only preflight. Captures the real provider request using MockTransport only."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import urllib.request
import httpx
from sqlalchemy import text
from shared.database import engine, database_url
from modules.intelliops.investigation_llm import InvestigationProvider
from modules.intelliops.investigation_schemas import ACTION_MEANINGS
from modules.intelliops.investigation_projection import model_evidence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', default='CASE-000010', choices=['CASE-000010', 'CASE-000011', 'CASE-000009'])
    parser.add_argument('--verify-after', action='store_true', help='Compare source records only; no model or backend call.')
    parser.add_argument('--output-dir', default=str(Path(__file__).resolve().parents[1] / 'logs' / 'phase2-controlled-A'))
    args = parser.parse_args()
    folder = Path(args.output_dir).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    if not args.verify_after:
        assert not (folder / (args.case + '.attempt')).exists(), 'A live attempt already exists; do not repeat.'
    assert database_url.get_backend_name() == 'postgresql' and 'supabase.' in (database_url.host or '')
    with engine.connect().execution_options(isolation_level='REPEATABLE READ', postgresql_readonly=True) as conn:
        database = conn.execute(text('select current_database()')).scalar_one()
        readonly = conn.execute(text('show transaction_read_only')).scalar_one()
        assert readonly == 'on'
        tables = ['accounts', 'customers', 'transactions', 'payment_instructions', 'payment_requests',
                  'processing_events', 'ledger_journals', 'ledger_entries', 'ledger_records', 'exceptions',
                  'exception_case_actions', 'audit_events', 'exception_batches', 'exception_batch_items']
        hashes = {}
        for table in tables:
            rows = conn.execute(text('SELECT * FROM ' + table)).mappings().all()
            encoded = sorted(json.dumps(dict(row), sort_keys=True, default=str) for row in rows)
            hashes[table] = dict(count=len(rows), sha256=hashlib.sha256(json.dumps(encoded).encode()).hexdigest())
        conn.rollback()
    if args.verify_after:
        before = json.loads((folder / 'source-before.json').read_text(encoding='utf-8'))
        changed = [table for table in tables if before.get(table) != hashes[table]]
        result = dict(sourceRecordsUnchanged=not changed, tablesChecked=len(tables), changedTables=changed,
                      transactionReadOnly=readonly)
        (folder / 'source-after.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
        (folder / 'source-comparison.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result))
        return
    (folder / 'source-before.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    request = urllib.request.Request('http://127.0.0.1:8000/api/exceptions/' + args.case + '/investigation-evidence',
                                    headers={'Authorization': 'Bearer ' + os.environ['INTELLIOPS_ADMIN_TOKEN']})
    with urllib.request.urlopen(request, timeout=90) as response:
        evidence = json.load(response)
    projected = model_evidence(evidence)
    captured = {}
    def handler(request):
        captured.update(json.loads(request.content))
        result = dict(diagnosis_classification='SUSPECTED_DUPLICATE', root_cause_code='CAUSE_NOT_ESTABLISHED',
            root_cause_title='Offline preflight only', root_cause_explanation='No live model inference was performed.',
            root_cause_evidence_refs=[], financial_classification=projected['financial_verification']['classification'],
            facts=[dict(statement='Records are available.', evidence_refs=projected['evidence_references'][:1])],
            hypotheses=[], uncertainty=['Offline preflight does not evaluate reasoning.'],
            recommended_action_code='ESCALATE_FOR_PAYMENT_VERIFICATION', recommendation_reason='Human review required.')
        return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': json.dumps(result)}]}]})
    provider = InvestigationProvider(httpx.MockTransport(handler))
    previous = os.environ.get('INTELLIOPS_LLM_DIAGNOSTICS_DIR')
    os.environ['INTELLIOPS_LLM_DIAGNOSTICS_DIR'] = ''
    try:
        provider.analyze(projected)
    finally:
        if previous is None: os.environ.pop('INTELLIOPS_LLM_DIAGNOSTICS_DIR', None)
        else: os.environ['INTELLIOPS_LLM_DIAGNOSTICS_DIR'] = previous
    schema = captured['text']['format']['schema']
    action_schema = schema['properties']['recommended_action_code']
    assert set(action_schema['enum']) == set(ACTION_MEANINGS)
    for code, meaning in ACTION_MEANINGS.items():
        assert f'{code}: {meaning}' in captured['instructions']
        assert f'{code}: {meaning}' in action_schema['description']
    refs = list(dict.fromkeys(projected['evidence_references']))
    assert schema['properties']['root_cause_evidence_refs']['items']['enum'] == refs
    assert schema['$defs']['EvidenceClaim']['properties']['evidence_refs']['items']['enum'] == refs
    assert 'financial_verification' not in refs
    forbidden = ['verified_assessment', 'root_cause_code', 'diagnosis_classification', 'recommended_action_code',
                 'CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS', 'expected_root_cause']
    encoded = captured['input']
    assert not any(value in encoded for value in forbidden)
    summary = dict(status='PREFLIGHT_PASSED_NO_PAID_CALL', caseId=args.case, paidCalls=0,
        database=dict(hostname=database_url.host, name=database, transactionReadOnly=readonly),
        configuration=dict(model=captured['model'], maxOutputTokens=captured['max_output_tokens'],
                           timeoutSeconds=provider.last_metadata['timeout_seconds']),
        referenceCount=len(refs), requestChronology=projected['snapshot']['requestChronology'],
        financialVerification=projected['financial_verification'], markerFresh=True,
        transport='httpx.MockTransport; no OpenAI network call', automaticRetries=False)
    (folder / 'mocked-responses-request.json').write_text(json.dumps(captured, indent=2), encoding='utf-8')
    (folder / 'preflight.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k != 'financialVerification'}, indent=2))


if __name__ == '__main__': main()
