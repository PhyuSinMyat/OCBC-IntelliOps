# Reviewed synthetic investigation fixtures

These three JSON files are offline regression inputs, not production exports or
raw OpenAI HTTP request/response dumps. They contain synthetic payment/request/
authorization IDs and banking evidence from the project's approved demonstration
cases. There are no provider request envelopes, system prompts, authorization
headers, API keys, connection strings or real customer identities.

- `accepted_investigation_reports.json`: factual-projection snapshots and accepted
  application reports for A/B/C, used by browser rendering tests. They do not seed
  a database or authorize financial actions. Historical provider usage metadata
  is display data, not a new paid call.
- `investigation_live_monetary_replay.json`: reviewed synthetic evidence plus
  unchanged analysis excerpts for accepted A and financially incorrect B. The B
  cents-as-major-units mistake must remain present so the validator rejects it.
- `investigation_authorization_live_replay.json`: unchanged earlier C analysis
  and factual replay evidence. It must remain application/financial-valid while
  receiving authorization rationale/citation review flags.

Checksums preserve analysis provenance; `provenance` strings refer to historical
ignored local artifacts but are not read as paths by the tests. Replays use only
these checked-in fixture files. Keeping the historic mistake is intentional;
changing an expected answer to make a test pass would defeat the regression.
Do not copy actual local credentials, private exports or raw provider dumps into
this directory. The payment amounts and identifiers are synthetic case evidence,
not simulator ground truth injected into a live model input.
