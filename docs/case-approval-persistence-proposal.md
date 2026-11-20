# Durable case approval proposal

Investigation requests and accepted reports are in `investigation_records`. Review notes, case transitions and remediation actions use `exception_case_actions` and `audit_events`. The current planner, communication, policy assessment and approval workflows are browser-session simulations. Their contents cannot authorize server case transitions.

## Proposed additive migration

The [SQL review draft](case-approval-schema-draft.sql) defines the tables and constraints. It ends with a rollback and sits outside the migration directories. A deployable migration would need to provision permissions for the FastAPI service and test the upgrade on a disposable database.

| Record | Required relationship and safeguards |
|---|---|
| Resolution plan version | Case FK, accepted investigation FK, server-generated plan ID and version, versioned evidence and customer context, authenticated author and timestamp. Unique plan ID and version. Submitted versions are immutable. |
| Policy assessment | FK to the exact plan version, verified financial evidence reference, server-evaluated result and timestamp. The backend validates eligibility at submission. |
| Approval request | FK to the exact assessed plan version, authenticated submitter and timestamp. A partial unique constraint permits at most one pending request per case. |
| Administrator decision | Unique approval request FK, authenticated administrator identity, decision, reason and timestamp, and an existing audit reference. Decisions are append-only. |

Customer communication used to authorize a proposal also needs an authoritative case-scoped snapshot with provenance. A client session record may be shown in a simulation. The server must independently verify any evidence used to release an actual control.

The existing demo bearer authentication identifies roles. Durable decisions require individual actor identity so the application can identify the deciding administrator and enforce separation of duties. Session tokens and simulated decisions should not be backfilled into these tables.

## Transition contract

- A verified start or durable work event moves Open to In Progress. An explicit revision event bound to a rejected version moves Rejected — Needs Revision to In Progress.
- In Progress or Rejected — Needs Revision moves to Pending Approval only when the backend stores an eligible request for the exact current version.
- A Pending Approval request moves to Approved — Awaiting Action or Rejected — Needs Revision only through an authenticated administrator decision on that request. An out-of-date plan version is rejected.
- Each transition and audit event is written atomically with its supporting record. Approval leaves execution pending. Existing controlled remediation and terminal case states retain their own authorization.

## API checks required before enabling the workflow

1. Lock the case before creating a plan version, submitting, deciding or revising. Validate that the referenced investigation belongs to that case and has an accepted report. Resolve customer context and financial evidence on the server.
2. At submission, recheck that the version is current and that its assessment permits requesting approval. Bind the request to the exact stored version and assessment. A newer version supersedes a pending request before it can be decided.
3. At decision, derive the administrator identity from verified authentication. Compare it with the submitter and require distinct identities. Recheck the request state, current plan version and evidence before recording the decision.
4. Store the decision, request outcome, case status and audit event in the same transaction. Repeated submission or decision requests must return the recorded result for the same idempotency key or reject conflicting content.
5. Treat saved plan versions, assessments and decisions as immutable. An authorization check must resolve the exact current plan version and its decision. A decision on a previous version remains available in history.

The draft's foreign keys and unique index cover version relationships, a single pending request per case, and one decision per request. Eligibility, evidence freshness, actor authorization, immutability and the coupling between request outcome and the case transition still require server-side enforcement.

This is a migration proposal. It adds no tables to the shared database. Implementation requires approval of the schema and actor identity contract.
