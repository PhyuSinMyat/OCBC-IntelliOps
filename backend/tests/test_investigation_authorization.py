"""Offline authorization, uncertainty and action-consistency audit regressions."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import hashlib
import json
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from sqlalchemy import select
from sqlalchemy.orm import Session
import test_investigation_evidence_phase1 as fixtures
import test_investigation_phase2 as phase2
from modules.payment_processing.scenarios import A, B, C
from modules.payment_processing.models import ProcessingEvent
from modules.intelliops.investigation_projection import model_evidence
from modules.intelliops.investigation_schemas import ModelInvestigation
from modules.intelliops.investigation_service import investigate
from modules.intelliops.investigation_validation import validate_monetary_claims
from modules.intelliops.service import CaseError


class AuthorizationTests(unittest.TestCase):
    setUp = fixtures.EvidencePhase1Tests.setUp
    tearDown = fixtures.EvidencePhase1Tests.tearDown
    generate = fixtures.EvidencePhase1Tests.generate
    evidence = fixtures.EvidencePhase1Tests.evidence
    provider = phase2.Phase2Tests.provider
    run_offline = phase2.Phase2Tests.run_offline

    def separate_output(self, evidence, action='REVIEW_FALSE_POSITIVE_CLOSURE', reason='Review the separately authorized instructions.'):
        def mutate(output):
            output.update(diagnosis_classification='LEGITIMATE_SEPARATE_INSTRUCTIONS',
                          recommended_action_code=action, recommendation_reason=reason)
            auth = [e for e in evidence['snapshot']['events'] if e['eventType'] == 'PAYMENT_AUTHORIZED']
            output['facts'] = [dict(statement='Distinct authorizations bind to separate requests and matching payment attributes.',
                                    evidence_refs=[f"event:{e['id']}" for e in auth])]
        return self.provider(mutate=mutate)

    def test_wire_retains_authorization_bindings_and_general_guidance(self):
        case, _ = self.generate(C); evidence = self.evidence(case); captured = {}
        before = fixtures.EvidencePhase1Tests.fingerprint(self)
        self.run_offline(evidence, self.provider(captured=captured))
        data = json.loads(captured['input']); s = data['snapshot']
        auth = [e for e in s['events'] if e['eventType'] == 'PAYMENT_AUTHORIZED']
        self.assertEqual(len(auth), 2)
        self.assertEqual(len({r['authorizationId'] for r in s['requests']}), 2)
        self.assertEqual(len({r['businessInstructionId'] for r in s['requests']}), 2)
        for request in s['requests']:
            self.assertTrue(request['authorizationValid'])
            event = next(e for e in auth if e['requestId'] == request['id'])
            self.assertEqual(event['sourceData']['authorization_id'], request['authorizationId'])
            self.assertEqual(event['sourceData']['intent_id'], request['businessInstructionId'])
            self.assertTrue(event['sourceData']['authorized'])
            for field in ('sender_account_ref', 'receiver_account_ref', 'amount', 'currency'):
                self.assertIn(field, event['sourceData'])
        self.assertIn('Missing reasons for a customer choosing to pay do not invalidate recorded authorization', captured['instructions'])
        self.assertIn('Cite the relevant authorization events in the findings', captured['instructions'])
        self.assertIn('material unresolved evidence', captured['text']['format']['schema']['properties']['recommendation_reason']['description'])
        for forbidden in ('verified_assessment', 'recommended_action_code', 'expected_root_cause', C):
            self.assertNotIn(forbidden, captured['input'])
        self.assertEqual(before, fixtures.EvidencePhase1Tests.fingerprint(self))

    def test_unknown_motivation_does_not_preclude_supported_closure_review(self):
        case, _ = self.generate(C); evidence = self.evidence(case)
        report = self.run_offline(evidence, self.separate_output(evidence))
        self.assertEqual(report['root_cause_code'], 'CAUSE_NOT_ESTABLISHED')
        self.assertEqual(report['recommended_action_code'], 'REVIEW_FALSE_POSITIVE_CLOSURE')
        self.assertEqual(report['review_flags'], [])

    def test_valid_authorizations_with_shared_correlation_and_close_times(self):
        case, _ = self.generate(C); evidence = self.evidence(case)
        data = model_evidence(evidence)
        requests = data['snapshot']['requests']
        self.assertEqual(requests[0]['correlationId'], requests[1]['correlationId'])
        self.assertEqual(data['snapshot']['requestChronology'][0]['receivedIntervalSeconds'], '5.000000')
        self.assertEqual(self.run_offline(evidence, self.separate_output(evidence))['diagnosis_classification'], 'LEGITIMATE_SEPARATE_INSTRUCTIONS')

    def test_safe_fallback_preserved_and_flagged_without_judging_materiality_by_keywords(self):
        case, _ = self.generate(C); evidence = self.evidence(case)
        for reason in ('Customer motivation is unknown.', 'Obtain external approval evidence for a disputed payment; the source snapshot cannot establish its current validity.'):
            with self.subTest(reason=reason):
                report = self.run_offline(evidence, self.separate_output(evidence, 'ESCALATE_FOR_PAYMENT_VERIFICATION', reason))
                self.assertEqual(report['recommended_action_code'], 'ESCALATE_FOR_PAYMENT_VERIFICATION')
                self.assertEqual(report['recommendation_reason'], reason)
                self.assertEqual([f['code'] for f in report['review_flags']], ['SEPARATE_AUTHORIZATIONS_ESCALATION_REVIEW'])

    def test_missing_and_conflicting_authorizations_reject_positive_conclusions_but_allow_fallback(self):
        for kind in ('missing', 'wrong_amount', 'denied'):
            with self.subTest(kind=kind):
                case, _ = self.generate(C, key='authorization-' + kind)
                with Session(self.engine) as db, db.begin():
                    event = db.scalar(select(ProcessingEvent).where(ProcessingEvent.event_type == 'PAYMENT_AUTHORIZED').order_by(ProcessingEvent.id.desc()))
                    if kind == 'missing': db.delete(event)
                    else:
                        payload = json.loads(event.details)
                        payload.update({'amount': '999.99'} if kind == 'wrong_amount' else {'authorized': False})
                        event.details = json.dumps(payload)
                evidence = self.evidence(case)
                self.assertTrue(any(not r['authorizationValid'] for r in evidence['snapshot']['requests']))
                with self.assertRaisesRegex(CaseError, 'relationship'):
                    self.run_offline(evidence, self.separate_output(evidence))
                report = self.run_offline(evidence, self.provider())
                self.assertEqual(report['recommended_action_code'], 'ESCALATE_FOR_PAYMENT_VERIFICATION')
                self.assertEqual(report['review_flags'], [])

    def test_shared_customer_repeat_and_system_retry_do_not_become_independent_authorizations(self):
        for scenario in (A, B):
            case, _ = self.generate(scenario, key='not-independent-' + scenario)
            evidence = self.evidence(case)
            requests = evidence['snapshot']['requests']
            self.assertFalse(any(r['authorizationValid'] for r in requests))
            if scenario == B:
                self.assertEqual({r['origin'] for r in requests}, {'CUSTOMER', 'SYSTEM'})
                self.assertTrue(any(r['retryValid'] for r in requests))
            else: self.assertEqual({r['origin'] for r in requests}, {'CUSTOMER'})
            with self.assertRaises(CaseError):
                self.run_offline(evidence, self.provider(mutate=lambda o: o.update(
                    diagnosis_classification='LEGITIMATE_SEPARATE_INSTRUCTIONS', recommended_action_code='REVIEW_FALSE_POSITIVE_CLOSURE')))

    def test_contradictory_specific_action_rejected_without_rewrite(self):
        case, _ = self.generate(C); evidence = self.evidence(case)
        with self.assertRaisesRegex(CaseError, 'recommendation'):
            self.run_offline(evidence, self.separate_output(evidence, 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION'))

    def test_separate_authorization_checks_must_cover_both_selected_payments(self):
        case, _ = self.generate(C); evidence = deepcopy(self.evidence(case))
        requests = evidence['snapshot']['requests']
        requests[1]['paymentReference'] = requests[0]['paymentReference']
        with self.assertRaisesRegex(CaseError, 'relationship'):
            self.run_offline(evidence, self.separate_output(evidence))

    def test_actual_c_replay_remains_schema_financial_valid_but_has_review_flags(self):
        saved = json.loads((Path(__file__).parent / 'fixtures/investigation_authorization_live_replay.json').read_text())
        analysis = saved['analysis']; before = deepcopy(analysis)
        self.assertEqual(hashlib.sha256(json.dumps(analysis, sort_keys=True).encode()).hexdigest(), saved['analysisSha256'])
        result = ModelInvestigation.model_validate(analysis)
        validate_monetary_claims(result, model_evidence(saved['evidence']))
        class Provider:
            def analyze(self, data): return result, 'offline-replay'
        report = investigate(saved['evidence'], Provider())
        self.assertEqual(analysis, before)
        self.assertEqual(report['llm_analysis'], analysis)
        self.assertEqual(report['recommended_action_code'], 'ESCALATE_FOR_PAYMENT_VERIFICATION')
        self.assertEqual({f['code'] for f in report['review_flags']}, {
            'SEPARATE_AUTHORIZATIONS_ESCALATION_REVIEW', 'AUTHORIZATION_FINDING_CITATIONS_REVIEW'})


if __name__ == '__main__': unittest.main()
