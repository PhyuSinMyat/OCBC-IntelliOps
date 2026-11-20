import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from modules.intelliops.severity import assess_severity, operational_failure, systemic_findings


class SeverityTests(unittest.TestCase):
    def test_rule_matrix(self):
        for code, evidence, expected in [
            ("MISSING_LEDGER_POSTING", {"classification": "NO_POSTING_RECORD", "cutoff": "2026-11-20"}, "HIGH"),
            ("MISSING_LEDGER_POSTING", {}, "MEDIUM"),
            ("AMOUNT_MISMATCH", {"representation": "MODERN", "expectedAmount": "12.01", "postedAmount": "12.00", "tolerance": "0"}, "HIGH"),
            ("AMOUNT_MISMATCH", {"representation": "MODERN"}, "MEDIUM"),
            ("UNMATCHED_TRANSACTION", {}, "MEDIUM"),
            ("UNMATCHED_TRANSACTION", {"financialDiscrepancy": True}, "HIGH"),
            ("DUPLICATE_TRANSACTION", {"financialAssessment": "TWO_POSTINGS_CONFIRMED"}, "HIGH"),
            ("DUPLICATE_TRANSACTION", {"financialAssessment": "SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD"}, "LOW"),
            ("DUPLICATE_TRANSACTION", {}, "MEDIUM"),
            ("PAYMENT_PROCESSING_FAILURE", {"failureContained": True}, "LOW"),
            ("PAYMENT_PROCESSING_FAILURE", {}, "MEDIUM"),
            ("PAYMENT_PROCESSING_FAILURE", {"failureContained": True, "financialMovementObserved": True}, "HIGH"),
            ("LEDGER_ACCOUNT_MISMATCH", {"financialDiscrepancy": True}, "HIGH"),
            ("LEDGER_CURRENCY_MISMATCH", {"financialDiscrepancy": True}, "HIGH"),
            ("INVALID_LEDGER_POSTING", {}, "MEDIUM"),
            ("PROCESSING_TIMEOUT", {}, "MEDIUM"),
        ]:
            with self.subTest(code=code, evidence=evidence):
                outcome = assess_severity(code, evidence)
                self.assertEqual(outcome["severity"], expected)
                self.assertEqual(outcome, assess_severity(code, {
                    **evidence, "scenario_code": "PRIVATE_LABEL", "expectedRootCause": "PRIVATE_ANSWER",
                }))
        self.assertIn("intent has not been established", assess_severity("DUPLICATE_TRANSACTION",
            {"financialAssessment": "TWO_POSTINGS_CONFIRMED"})["reason"])

    def test_terminal_failure_requires_affirmative_and_uncontradicted_evidence(self):
        failed = SimpleNamespace(event_type="PROCESSING_FAILED", error_code=None)
        timeout = SimpleNamespace(event_type="PROCESSOR_TIMEOUT", error_code=None)
        posted = SimpleNamespace(event_type="LEDGER_POSTED", error_code=None)
        for events, records, expected in [
            ([], False, False), ([failed], False, True), ([failed, timeout], False, False),
            ([failed, posted], False, False), ([failed], True, False),
        ]:
            self.assertEqual(operational_failure(events, has_records=records, has_movement=False,
                                                failure_code=None)["failureContained"], expected)

    def test_systemic_requires_recent_distinct_transactions_and_customers(self):
        now = datetime(2026, 11, 20, tzinfo=timezone.utc)
        code = "MISSING_LEDGER_POSTING"
        cohort = [(code, index, index % 3, now - timedelta(seconds=index * 20)) for index in range(1, 11)]
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(systemic_findings(cohort[:1] * 10, now))
            self.assertFalse(systemic_findings([(kind, tx, "one customer", stamp)
                                               for kind, tx, _, stamp in cohort], now))
            self.assertFalse(systemic_findings(cohort, now + timedelta(minutes=8)))
            findings = systemic_findings(cohort, now)
        self.assertEqual(len(findings), 10)
        assessment = assess_severity(code, {"classification": "NO_POSTING_RECORD", "cutoff": now.isoformat()},
                                     findings[(code, 1)])
        self.assertEqual(assessment["severity"], "CRITICAL")
        self.assertEqual(assessment["aggregateEvidence"]["customerCount"], 3)
