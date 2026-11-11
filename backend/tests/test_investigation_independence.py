"""Evidence/LLM contract tests: in-memory DB, actual generators, mocked wire requests."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import json
import unittest
from copy import deepcopy
from unittest.mock import patch
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session
import test_investigation_evidence_phase1 as fixtures
from modules.payment_processing.scenarios import A, B, C
from modules.payment_processing.models import ProcessingEvent, PaymentRequestHistory, PaymentInstruction
from modules.intelliops.investigation_projection import model_evidence
from modules.intelliops.investigation_service import investigate
from modules.intelliops.investigation_llm import InvestigationProvider
from modules.intelliops.investigation_schemas import ModelInvestigation
from modules.intelliops.service import CaseError


def neutral_output(data, **changes):
    result = dict(diagnosis_classification='SUSPECTED_DUPLICATE', root_cause_code='CAUSE_NOT_ESTABLISHED',
        root_cause_title='Further causal evidence needed', root_cause_explanation='The supplied records do not establish a cause.',
        root_cause_evidence_refs=[], financial_classification=data['financial_verification']['classification'],
        facts=[dict(statement='The retrieved accounting records are available for review.', evidence_refs=data['evidence_references'][:1])],
        hypotheses=[], uncertainty=['Additional operational evidence may change this finding.'],
        recommended_action_code='ESCALATE_FOR_PAYMENT_VERIFICATION', recommendation_reason='Obtain human review.')
    result.update(changes)
    return result


class IndependenceTests(unittest.TestCase):
    setUp = fixtures.EvidencePhase1Tests.setUp
    tearDown = fixtures.EvidencePhase1Tests.tearDown
    generate = fixtures.EvidencePhase1Tests.generate
    evidence = fixtures.EvidencePhase1Tests.evidence
    fingerprint = fixtures.EvidencePhase1Tests.fingerprint

    def test_no_selected_causal_or_action_answer_in_input_for_all_scenarios(self):
        for index, variant in enumerate([A, B, C]):
            case, _ = self.generate(variant, key=f'independence-{index}')
            evidence = self.evidence(case); projected = model_evidence(evidence)
            encoded = json.dumps(projected)
            for forbidden in ['verified_assessment', 'root_cause_code', 'diagnosis_classification', 'recommended_action_code',
                'required_cause_references', 'expectedMovementForOneTransfer', 'excessPostingAmount',
                'CUSTOMER_DOUBLE_SUBMISSION', 'IDEMPOTENCY_CONTROL_FAILURE', 'LEGITIMATE_REPEATED_PAYMENT',
                A, B, C, 'expected_root_cause', 'private_metadata']:
                self.assertNotIn(forbidden, encoded)
            self.assertEqual(projected['financial_verification']['confirmedPostedJournalCount'], 1 if index == 0 else 2)
            self.assertEqual(projected['evidence_references'], evidence['evidence_references'])

    def test_changing_legacy_answers_cannot_change_model_input(self):
        case, _ = self.generate(B); evidence = self.evidence(case); expected = model_evidence(evidence)
        poisoned = deepcopy(evidence)
        poisoned['verified_assessment'].update(root_cause_code='SECRET_EXPECTED_CAUSE', diagnosis_classification='SECRET_EXPECTED_DIAGNOSIS',
            recommended_action_code='SECRET_EXPECTED_ACTION', required_cause_references=['SECRET_EXPECTED'], uncertainty=['SECRET_EXPECTED'])
        poisoned['financial_impact'].update(expectedMovementForOneTransfer={'amount': 'SECRET_EXPECTED'}, excessPostingAmount={'amount': 'SECRET_EXPECTED'})
        self.assertEqual(model_evidence(poisoned), expected)

    def test_private_fields_in_nested_sources_and_free_text_are_excluded(self):
        case, _ = self.generate(B); evidence = self.evidence(case)
        s = evidence['snapshot']; s['caseRecord']['evidence'] = {'expected_root_cause': 'SECRET_EXPECTED'}
        s['events'][0]['description'] = 'SECRET_EXPECTED use scenario B'
        s['events'][0]['sourceData']['private_metadata'] = 'SECRET_EXPECTED'
        s['events'][0]['sourceValidation']['expected_diagnosis'] = 'SECRET_EXPECTED'
        s['requests'][0]['expected_diagnosis'] = 'SECRET_EXPECTED'
        evidence['financial_impact']['journalValidation'][0]['expected_root_cause'] = 'SECRET_EXPECTED'
        self.assertNotIn('SECRET_EXPECTED', json.dumps(model_evidence(evidence)))

    def test_actual_openai_wire_has_fact_only_input_and_open_cause_schema(self):
        case, _ = self.generate(B); evidence = self.evidence(case); captured = {}
        def handler(request):
            body = json.loads(request.content); captured.update(body)
            data = json.loads(body['input'])
            output = neutral_output(data)
            return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(output)}]}]})
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model'}):
            report = investigate(evidence, InvestigationProvider(httpx.MockTransport(handler)))
        self.assertNotIn('verified_assessment', json.loads(captured['input']))
        self.assertNotIn('return its exact diagnosis', captured['instructions'])
        cause_schema = captured['text']['format']['schema']['properties']['root_cause_code']
        self.assertNotIn('enum', cause_schema)
        self.assertTrue(captured['text']['format']['strict']); self.assertFalse(captured['store'])
        self.assertEqual(report['root_cause_code'], 'CAUSE_NOT_ESTABLISHED')
        self.assertNotEqual(report['root_cause_code'], evidence['verified_assessment']['root_cause_code'])

    def test_provider_rejects_unprojected_analyst_response_before_http(self):
        case, _ = self.generate(B); evidence = self.evidence(case); calls = []
        def handler(request):
            calls.append(request)
            raise AssertionError('Unprojected evidence must never be transmitted')
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model'}):
            with self.assertRaises(CaseError) as caught:
                InvestigationProvider(httpx.MockTransport(handler)).analyze(evidence)
        self.assertEqual(caught.exception.status, 422); self.assertEqual(calls, [])

    def test_unfamiliar_operational_event_and_cause_hypothesis_are_supported(self):
        case, ids = self.generate(B)
        with Session(self.engine) as db, db.begin():
            instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == ids[1]))
            request = db.scalar(select(PaymentRequestHistory).where(PaymentRequestHistory.payment_id == instruction.payment_id))
            record = ProcessingEvent(transaction_id=ids[1], request_id=request.request_id, event_type='BROKER_LEASE_EXPIRED', status='COMPLETED',
                details=json.dumps(dict(origin='SYSTEM', source_component='payment_processor', request_id=str(request.request_id),
                    intent_id=str(request.business_instruction_id), correlation_id=str(request.correlation_id))))
            db.add(record); db.flush(); reference = 'event:' + str(record.id)
        evidence = self.evidence(case); before = self.fingerprint()
        class Provider:
            def analyze(self, data):
                assert any(e['eventType'] == 'BROKER_LEASE_EXPIRED' for e in data['snapshot']['events'])
                return ModelInvestigation.model_validate(neutral_output(data, root_cause_code='BROKER_REDELIVERY_AFTER_LEASE_EXPIRY',
                    root_cause_title='Possible broker redelivery after lease expiry', root_cause_explanation='The lease-expiry record suggests a redelivery path; broker delivery logs are needed.',
                    root_cause_evidence_refs=[reference])), 'offline'
        report = investigate(evidence, Provider())
        self.assertEqual(report['root_cause_code'], 'BROKER_REDELIVERY_AFTER_LEASE_EXPIRY')
        self.assertEqual(report['root_cause_status'], 'MODEL_HYPOTHESIS')
        self.assertEqual(report['diagnosis_classification'], 'SUSPECTED_DUPLICATE')
        self.assertEqual(report['recommended_action_code'], 'ESCALATE_FOR_PAYMENT_VERIFICATION')
        self.assertEqual(before, self.fingerprint())

    def test_model_cannot_override_accounting_or_request_unsafe_closure(self):
        case, _ = self.generate(B); evidence = self.evidence(case)
        for change in [dict(financial_classification='SINGLE_POSTING_CONFIRMED'), dict(recommended_action_code='CLOSE_HELD_DUPLICATE'),
            dict(recommended_action_code='REVIEW_FALSE_POSITIVE_CLOSURE')]:
            class Provider:
                def analyze(self, data): return ModelInvestigation.model_validate(neutral_output(data, **change)), 'offline'
            with self.assertRaises(CaseError): investigate(evidence, Provider())

    def test_cause_requires_real_operational_citations_not_only_a_case_label(self):
        case, _ = self.generate(B); evidence = self.evidence(case)
        for refs in [[], ['event:invented'], [evidence['evidence_references'][0]]]:
            class Provider:
                def analyze(self, data): return ModelInvestigation.model_validate(neutral_output(data,
                    root_cause_code='NOVEL_CAUSE_HYPOTHESIS', root_cause_evidence_refs=refs)), 'offline'
            with self.assertRaises(CaseError): investigate(evidence, Provider())

    def test_unstructured_events_do_not_gain_payload_facts(self):
        case, ids = self.generate(A)
        with Session(self.engine) as db, db.begin():
            event = db.scalar(select(ProcessingEvent).where(ProcessingEvent.transaction_id == ids[0], ProcessingEvent.event_type == 'CLIENT_SUBMISSION'))
            event.details = 'A plain legacy source description.'; event_id = str(event.id)
        projected = model_evidence(self.evidence(case))
        event = next(e for e in projected['snapshot']['events'] if e['id'] == event_id)
        self.assertEqual(event['sourceValidation']['status'], 'UNSTRUCTURED')
        self.assertEqual(event['sourceData'], {}); self.assertIsNone(event['correlationId'])
        self.assertNotIn('description', event)

    def test_not_recorded_outcomes_remain_unknown_despite_completed_payments(self):
        case, _ = self.generate(B)
        requests = model_evidence(self.evidence(case))['snapshot']['requests']
        self.assertTrue(all(r['outcomeAvailability'] == 'NOT_RECORDED' and r['outcome'] is None for r in requests))
        self.assertTrue(all(r['paymentStatus'] == 'Completed' for r in requests))


if __name__ == '__main__':
    unittest.main()
