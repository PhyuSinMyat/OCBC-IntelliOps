"""Versioned executable rule registry. Configuration never supplies executable code."""
from dataclasses import dataclass, field
from sqlalchemy import select
from .models import DetectionRule


class DetectionConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class RuleSpec:
    code: str
    exception_type: str
    description: str
    severity: str = "HIGH"
    defaults: dict = field(default_factory=dict)
    # Legacy integer threshold now has a documented, explicit unit per rule.
    threshold_key: str | None = None


RULES = (
    RuleSpec("DUPLICATE_TRANSACTION", "Duplicate Transaction", "Potential duplicate pair; posting assessment is separate.", defaults={"similarity_window_seconds": 120}),
    RuleSpec("PAYMENT_PROCESSING_FAILURE", "Payment Processing Failure", "Payment source reports FAILED."),
    RuleSpec("MISSING_LEDGER_POSTING", "Missing Ledger Posting", "Completed payment has no linked modern or legacy posting after cutoff.", threshold_key="reconciliation_seconds"),
    RuleSpec("UNMATCHED_TRANSACTION", "Unmatched Transaction", "Internally valid journal conflicts with source transaction reference.", "MEDIUM", threshold_key="reconciliation_seconds"),
    RuleSpec("AMOUNT_MISMATCH", "Amount Mismatch", "Payment differs from valid payment-aligned posting totals.", defaults={"amount_tolerance_cents": 0}, threshold_key="amount_tolerance_cents"),
    RuleSpec("INVALID_LEDGER_POSTING", "Invalid Ledger Posting", "Linked journal/legacy evidence is incomplete, invalid or internally unbalanced.", threshold_key="reconciliation_seconds"),
    RuleSpec("LEDGER_ACCOUNT_MISMATCH", "Ledger Account Mismatch", "Internally valid journal posts to accounts inconsistent with the instruction.", threshold_key="reconciliation_seconds"),
    RuleSpec("LEDGER_CURRENCY_MISMATCH", "Ledger Currency Mismatch", "Journal/legacy currency differs from the payment currency.", threshold_key="reconciliation_seconds"),
    RuleSpec("PROCESSING_TIMEOUT", "Processing Timeout", "Unheld PENDING/PROCESSING payment breaches inactivity or maximum-age policy.", defaults={"inactivity_seconds": 300, "max_pending_seconds": 1800}, threshold_key="inactivity_seconds"),
)
BY_CODE = {r.code: r for r in RULES}


def validate_configuration(spec, rule):
    config = {} if rule.configuration is None else rule.configuration
    allowed = set(spec.defaults)
    if spec.code in {"MISSING_LEDGER_POSTING", "UNMATCHED_TRANSACTION", "AMOUNT_MISMATCH", "INVALID_LEDGER_POSTING", "LEDGER_ACCOUNT_MISMATCH", "LEDGER_CURRENCY_MISMATCH"}:
        allowed.add("reconciliation_seconds")
    if not isinstance(config, dict) or set(config) - allowed:
        raise DetectionConfigurationError(f"Unsupported configuration for {spec.code}.")
    result = {**spec.defaults, **config}
    if rule.threshold is not None:
        if not spec.threshold_key or spec.threshold_key in config:
            raise DetectionConfigurationError(f"Ambiguous or unsupported legacy threshold for {spec.code}.")
        result[spec.threshold_key] = rule.threshold
    for key, value in result.items():
        minimum = 0 if key == "amount_tolerance_cents" else 1
        if type(value) is not int or value < minimum:
            raise DetectionConfigurationError(f"{spec.code}.{key} must be an integer >= {minimum}.")
    if rule.severity not in {"LOW", "MEDIUM", "HIGH", "CRITICAL"} or rule.version < 1:
        raise DetectionConfigurationError(f"Invalid severity/version for {spec.code}.")
    return result


def load_rules(db, now):
    """Materialize defaults only inside an authorized detection transaction.

    Migration also provisions defaults. This path supports metadata-created tests
    and new empty configurations. It never changes existing enabled/threshold values.
    PostgreSQL callers hold the detector advisory lock before entering this method.
    """
    rows = db.scalars(select(DetectionRule).order_by(DetectionRule.id)).all()
    types, codes = {}, {}
    for row in rows:
        if row.exception_type in types or row.code and row.code in codes:
            raise DetectionConfigurationError("Conflicting detection rule configurations.")
        types[row.exception_type] = row
        if row.code:
            codes[row.code] = row
    loaded = {}
    for spec in RULES:
        rule = codes.get(spec.code) or types.get(spec.exception_type)
        if rule and (rule.exception_type != spec.exception_type or rule.code not in (None, spec.code)):
            raise DetectionConfigurationError(f"Rule identity conflict for {spec.code}.")
        if rule is None:
            rule = DetectionRule(code=spec.code, name=spec.exception_type, exception_type=spec.exception_type,
                                 description=spec.description, severity=spec.severity,
                                 configuration={}, version=1, enabled=True, updated_at=now)
            db.add(rule)
        elif rule.code is None:
            if rule.threshold is not None:
                raise DetectionConfigurationError(f"Legacy threshold for {spec.code} requires explicit unit review.")
            rule.code, rule.description, rule.updated_at = spec.code, spec.description, now
        db.flush()
        loaded[spec.code] = (rule, validate_configuration(spec, rule))
    # Unknown legacy rules remain readable but cannot execute arbitrary conditions.
    return loaded
