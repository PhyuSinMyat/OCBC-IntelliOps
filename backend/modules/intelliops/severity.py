"""Initial severity from observed financial and operational evidence."""
import os
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal, InvalidOperation

AGGREGATE_RULES = {
    "MISSING_LEDGER_POSTING", "AMOUNT_MISMATCH",
    "LEDGER_ACCOUNT_MISMATCH", "LEDGER_CURRENCY_MISMATCH",
}
MOVEMENT_EVENTS = {"LEDGER_POSTED", "PROCESSING_COMPLETED"}
TERMINAL_FAILURE_EVENTS = {"PROCESSING_FAILED", "CLEARING_REJECTED"}


def operational_failure(events, *, has_records, has_movement, failure_code):
    kinds = {event.event_type for event in events}
    uncertain = ("TIMEOUT", "TIMED_OUT", "UNKNOWN")
    codes = [failure_code] + [event.error_code for event in events]
    ambiguous = any(token in (code or "").upper() for code in codes for token in uncertain)
    ambiguous |= any(token in kind for kind in kinds for token in uncertain)
    return {
        "financialMovementObserved": has_movement,
        "failureContained": bool(kinds & TERMINAL_FAILURE_EVENTS) and
            not (has_records or has_movement or kinds & MOVEMENT_EVENTS or ambiguous),
    }


def _threshold(name, default, minimum):
    try:
        return max(minimum, int(os.getenv("INTELLIOPS_SEVERITY_" + name, default)))
    except ValueError:
        return default


def systemic_findings(observations, now):
    """Cohort by defect type and deduplicate by transaction before counting."""
    window = _threshold("WINDOW_SECONDS", 900, 120)
    recent = min(window, _threshold("RECENT_SECONDS", 300, 1))
    min_payments = _threshold("MIN_TRANSACTIONS", 10, 2)
    min_customers = _threshold("MIN_CUSTOMERS", 3, 2)
    cohorts = defaultdict(dict)
    for code, transaction, customer, timestamp in observations:
        if code in AGGREGATE_RULES and now - timedelta(seconds=window) <= timestamp <= now:
            cohorts[code][transaction] = (customer, timestamp)
    systemic = {}
    for code, cohort in cohorts.items():
        customers = {customer for customer, _ in cohort.values() if customer is not None}
        times = [timestamp for _, timestamp in cohort.values()]
        if (len(cohort) >= min_payments and len(customers) >= min_customers
                and max(times) >= now - timedelta(seconds=recent)
                and max(times) - min(times) >= timedelta(seconds=60)):
            summary = dict(transactionCount=len(cohort), customerCount=len(customers),
                           windowSeconds=window, recentSeconds=recent, minimumSpanSeconds=60,
                           minimumTransactions=min_payments, minimumCustomers=min_customers)
            systemic.update({(code, transaction): summary for transaction in cohort})
    return systemic


def _verified_amount_mismatch(evidence):
    if evidence.get("representation") not in {"MODERN", "LEGACY"}:
        return False
    try:
        expected = Decimal(evidence["expectedAmount"])
        posted = Decimal(evidence["postedAmount"])
        tolerance = Decimal(evidence["tolerance"])
        return all(value.is_finite() for value in (expected, posted, tolerance)) and (
            tolerance >= 0 and abs(posted - expected) > tolerance)
    except (KeyError, InvalidOperation, TypeError):
        return False


def assess_severity(code, evidence, systemic=None):
    def assessment(level, reason_code, reason):
        return dict(severity=level, reasonCode=reason_code, reason=reason,
                    assessmentStage="DETECTION", ruleVersion="1.0")

    if systemic and code in AGGREGATE_RULES:
        return {**assessment("CRITICAL", "SYSTEMIC_RECONCILIATION_FAILURE",
            "Recent confirmed accounting defects of this type affect multiple customers and meet the systemic thresholds."),
            "aggregateEvidence": systemic}
    if code == "MISSING_LEDGER_POSTING" and evidence.get("classification") == "NO_POSTING_RECORD" and evidence.get("cutoff"):
        return assessment("HIGH", "COMPLETED_PAYMENT_MISSING_LEDGER",
                          "The completed payment had no corresponding ledger record after the reconciliation cutoff.")
    if code == "AMOUNT_MISMATCH" and _verified_amount_mismatch(evidence):
        return assessment("HIGH", "VERIFIED_AMOUNT_MISMATCH",
                          "The verified posting total differs from the completed payment amount.")
    if code == "DUPLICATE_TRANSACTION":
        outcome = evidence.get("financialAssessment")
        if outcome == "TWO_POSTINGS_CONFIRMED":
            return assessment("HIGH", "POTENTIAL_DOUBLE_EXECUTION",
                              "Two financial postings are confirmed. Independent payment intent has not been established.")
    if evidence.get("financialDiscrepancy") or evidence.get("financialMovementObserved"):
        return assessment("HIGH", "FINANCIAL_EXECUTION_REQUIRES_REVIEW",
                          "Observed accounting evidence indicates a discrepancy or financial movement requiring review.")
    if code == "DUPLICATE_TRANSACTION" and evidence.get("financialAssessment") == "SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD":
        return assessment("LOW", "DUPLICATE_SAFELY_HELD",
                          "The repeat request was held before execution and only one posting was verified.")
    if code == "PAYMENT_PROCESSING_FAILURE" and evidence.get("failureContained"):
        return assessment("LOW", "FAILURE_SAFELY_CONTAINED",
                          "A terminal failure was recorded with no corresponding ledger records or posting activity.")
    if code == "UNMATCHED_TRANSACTION":
        return assessment("MEDIUM", "UNRESOLVED_PAYMENT_REFERENCE",
                          "The payment reference could not be reconciled. A financial discrepancy has not been established.")
    return assessment("MEDIUM", "EXECUTION_REQUIRES_REVIEW",
                      "The available evidence does not establish financial exposure or safe containment.")
