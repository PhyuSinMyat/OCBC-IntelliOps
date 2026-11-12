"""Deterministic checks for explicit monetary assertions; not a semantic truth grader."""
import re
from decimal import Decimal
from .service import CaseError


def authorization_review_flags(result, snapshot, separate):
    """Review flags, not a semantic verdict or replacement recommendation.

    Preserve safe escalation even when authorizations are verified. A reviewer,
    not keyword matching, assesses whether its stated uncertainty is material.
    """
    if result.diagnosis_classification != 'LEGITIMATE_SEPARATE_INSTRUCTIONS' or not separate:
        return []
    flags = []
    if result.recommended_action_code == 'ESCALATE_FOR_PAYMENT_VERIFICATION':
        flags.append(dict(code='SEPARATE_AUTHORIZATIONS_ESCALATION_REVIEW',
            message='Separate authorizations are verified, but additional verification was proposed. Review which material unresolved evidence justifies escalation; unknown customer motivation alone does not invalidate authorization. The model action is preserved.'))
    cited = {ref for claim in result.facts + result.hypotheses for ref in claim.evidence_refs}
    required = {f"event:{event['id']}" for event in snapshot['events']
                if event['eventType'] == 'PAYMENT_AUTHORIZED' and event.get('relationshipValid')
                and event.get('sourceData', {}).get('authorized') is True}
    if not required or not required <= cited:
        flags.append(dict(code='AUTHORIZATION_FINDING_CITATIONS_REVIEW',
            message='The findings do not cite all relevant verified authorization events. Review the explanation of distinct authorization IDs, request/instruction bindings and payment attributes; a root-cause citation list alone is insufficient.'))
    return flags


def monetary_assertions(statement, currencies):
    """Bounded major-unit literals, not free-form arithmetic or a prose truth parser.

    Recognize ISO codes before/after amounts and prefix S$/$, including grouped
    thousands and at most two decimal places. Token boundaries exclude IDs and
    timestamp fragments. Bare numbers, spelled-out amounts and other formats are
    outside this check; source citation entailment still requires human review.
    """
    codes = '|'.join(re.escape(code) for code in currencies)
    number = r'-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?'
    pattern = re.compile(
        r'(?<![\w.:/\-])(?:(?P<prefix>' + codes + r'|S\$|\$)\s*(?P<before>' + number + r')'
        r'(?!\w|[.,]\d)|(?P<after>' + number + r')\s+(?P<suffix>' + codes + r')(?!\w))', re.I)
    for match in pattern.finditer(statement):
        yield (match['prefix'] or match['suffix']).upper(), match['before'] or match['after']


def validate_monetary_claims(result, model_input):
    s, financial = model_input['snapshot'], model_input['financial_verification']
    allowed = {}
    def add(currency, value):
        allowed.setdefault(currency, {Decimal(0)}).add(abs(Decimal(str(value))))
    for payment in (s['original'], s['duplicate']):
        if payment:
            add(payment['currency'], Decimal(payment['amountCents']) / 100)
    for entry in s['entries']:
        add(entry['currency'], Decimal(entry['amountCents']) / 100)
    for key in ('validDebitTotals', 'validCreditTotals'):
        for currency, amount in financial.get(key, {}).items():
            add(currency, amount)
    for movement in financial.get('accountMovements', []):
        for key in ('debit', 'credit', 'net'):
            add(movement['currency'], movement[key])
    currencies = sorted(set(allowed) | {'SGD', 'USD', 'EUR', 'GBP', 'AUD', 'JPY', 'CNY', 'HKD'})
    statements = [c.statement for c in result.facts + result.hypotheses]
    statements += [result.root_cause_title, result.root_cause_explanation, result.recommendation_reason] + result.uncertainty
    for statement in statements:
        for currency, raw in monetary_assertions(statement, currencies):
            currency = 'SGD' if currency == 'S$' else next(iter(allowed), None) if currency == '$' and len(allowed) == 1 else currency
            if currency not in allowed or abs(Decimal(raw.replace(',', ''))) not in allowed[currency]:
                raise CaseError(f'AI monetary statement {currency} {raw} is not a verified amount for this evidence; human verification is required.', 502)
        for value in re.findall(r'(?i)requests? (?:were |was )?(?:received |arrived )?(\d+(?:\.\d+)?) seconds? apart', statement):
            intervals = {Decimal(r['receivedIntervalSeconds']) for r in s.get('requestChronology', [])}
            if intervals and Decimal(value) not in intervals:
                raise CaseError('AI request chronology conflicts with persisted request timestamps.', 502)
