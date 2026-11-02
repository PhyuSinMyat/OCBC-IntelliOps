# OCBC IntelliOps

**Intelligent Operations — From Automation to Autonomous Resolution**  
**Project type:** Innovation challenge prototype | **Environment:** Synthetic banking simulation

> **Disclaimer:** OCBC IntelliOps is a student-team concept/prototype. It is not an official OCBC product or a representation of OCBC's internal architecture. All customers, accounts, payments, ledger postings and workflow records used in the demo must be fictional. The system must not connect to live banking infrastructure or execute real financial transactions.

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Problem statement and objectives](#2-problem-statement-and-objectives)
3. [Scope and delivery status](#3-scope-and-delivery-status)
4. [System architecture](#4-system-architecture)
5. [Portals and user interfaces](#5-portals-and-user-interfaces)
6. [End-to-end business workflow](#6-end-to-end-business-workflow)
7. [Source-system business flows](#7-source-system-business-flows)
8. [Exception scenarios](#8-exception-scenarios)
9. [Exception lifecycle and business rules](#9-exception-lifecycle-and-business-rules)
10. [AI investigation and autonomous resolution](#10-ai-investigation-and-autonomous-resolution)
11. [Database design](#11-database-design)
12. [Technical stack](#12-technical-stack)
13. [Repository structure](#13-repository-structure)
14. [Proposed API design](#14-proposed-api-design)
15. [Security, risk and audit requirements](#15-security-risk-and-audit-requirements)
16. [Local setup and configuration plan](#16-local-setup-and-configuration-plan)
17. [Testing and acceptance criteria](#17-testing-and-acceptance-criteria)
18. [Presentation demonstration script](#18-presentation-demonstration-script)
19. [Implementation roadmap](#19-implementation-roadmap)
20. [Glossary](#20-glossary)

---

## 1. Executive summary

**OCBC IntelliOps** is a proposed **agentic operational exception management platform** that detects abnormal events in simulated banking operations, gathers evidence, investigates probable causes, recommends or executes permitted corrective actions, verifies outcomes and maintains an audit trail.

Its central value proposition is **resolution, not merely detection**. An alert alone does not solve an operational problem; IntelliOps aims to move suitable exceptions through a controlled workflow to a verified outcome, while escalating cases requiring human judgement or authorization.

The demonstration uses three synthetic source systems:

1. **Payment Processing** — tracks transfer instructions and processing outcomes.
2. **Core Banking / Ledger** — tracks fictional accounts and the financial postings associated with transactions.
3. **Workflow Engine** — tracks operational processes, tasks, required approvals, errors and retries. For the MVP this is a backend simulator, not a separate visible portal.

The main **IntelliOps portal** consumes evidence from these systems. The presentation also includes lightweight **Payment Processing** and **Core Banking / Ledger** portals, so judges can inspect the records that generated an exception.

### Intended user roles

| Role | Primary Responsibilities |
|---|---|
| **Operations Analyst** | Monitor operational exceptions, investigate cases, examine AI-generated findings, assign cases, request corrective actions, and escalate unresolved issues. |
| **Administrator** | Perform all Analyst functions, approve or reject proposed resolution actions requiring human authorization, manage users, configure detection rules and resolution policies, and oversee system operations. 

### Role-Based Permissions

| Feature / Permission | Operations Analyst | Administrator |
|---|:---:|:---:|
| View Overview Dashboard | ✅ | ✅ |
| View Exception Center | ✅ | ✅ |
| Investigate Exceptions | ✅ | ✅ |
| View AI Investigation Results | ✅ | ✅ |
| Assign and Escalate Cases | ✅ | ✅ |
| Request Proposed Resolutions | ✅ | ✅ |
| View Resolution Workflows | ✅ | ✅ |
| View Approval Center | ✅ (Read-only) | ✅ |
| Approve Resolution Actions | ❌ | ✅ |
| Reject Resolution Actions | ❌ | ✅ |
| View Audit Trail | ✅ | ✅ |
| View Analytics | ✅ | ✅ |
| Manage Users and Roles | ❌ | ✅ |
| Configure Detection Rules | ❌ | ✅ |
| Configure Resolution Policies | ❌ | ✅ |
| Manage System Settings | ❌ | ✅ |

## 2. Problem statement and objectives

### Challenge framing

**Problem statement:** How might OCBC use AI agents, automation and data to resolve routine operational exceptions, not merely describe them?

Banks handle recurring operational checks, reconciliations, approvals, handovers and processing failures. Existing automation can complete individual steps without necessarily closing the underlying exception.

### Project objectives

- Detect and classify operational exceptions using explicit, reproducible rules.
- Collect relevant evidence from multiple synthetic source systems.
- Use AI to investigate, explain findings and suggest an appropriate next action.
- Automatically execute **only low-risk, explicitly permitted actions**.
- Route sensitive, ambiguous or high-impact cases to a human reviewer.
- Verify that an executed action actually resolved the problem before closing a case.
- Maintain traceable, timestamped audit records for every important decision and action.
- Demonstrate reduced manual steps and measured time to resolution.

### Out of scope

- Integration with live OCBC or other banking systems.
- Real customer information, real accounts or real transfers.
- Unrestricted automatic reversals, financial postings or balance edits.
- Autonomous high-risk decisions or bypassing mandatory approvals.
- A full retail-banking application or production-scale payment infrastructure.
- Production infrastructure incident management (including server-down recovery) in the initial MVP.
- Mistaken-recipient recovery as a core MVP scenario; this is a deferred enhancement.

## 3. Scope and delivery status

**Status as of the latest project discussion:**

| Component | Current known status | Next step |
|---|---|---|
| IntelliOps portal | Figma Make UI/prototype exists, including Overview, Exception Center, AI Investigation, Resolution Workflows, Approval Center and Audit Trail views | Validate interactions and connect to backend APIs |
| Payment Processing portal | Figma Make prototype exists | Refine to a single **Transactions** sidebar page with **Processing History** inside Transaction Details |
| Core Banking / Ledger portal | Figma Make prototype exists | Keep **Accounts** and **Ledger Journals** as separate navigation items; show entries in journal details |
| Workflow Engine | Architecture and schema planned | Build backend simulator; no separate UI required |
| Shared PostgreSQL data | Proposed schema/ERD established | Implement migrations and deterministic seed data |
| FastAPI services | Proposed | Implement APIs, rules and source simulators |
| LangGraph AI workflow | Proposed | Integrate after deterministic detection and policy services work |
| Verified autonomous resolution | Proposed | Deliver the first end-to-end safe retry flow |

> **Important:** A functioning Figma Make interaction may still be backed by local mock state. Do not describe a feature as deployed, integrated or autonomously executing unless it has been tested against the real backend.

### MVP scope

- Synthetic payment, ledger and workflow records.
- One shared, internally consistent dataset for all visible portals and IntelliOps.
- Transaction and ledger record drill-down.
- Rule-based exception detection and deduplication.
- Exception Center with filtering, details and evidence.
- AI-assisted investigation with structured evidence.
- One complete, policy-controlled, idempotent workflow-task retry.
- Human approval/escalation for unsuitable cases.
- Verification and append-only audit activity.

### Deferred enhancements

- Server/service outage monitoring and safe recovery simulations.
- Customer-reported mistaken-recipient transfer recovery workflows.
- Additional integrations, RPA, advanced dashboards and distributed job queues.

## 4. System architecture

Start with a **modular monolith**: one React frontend, one FastAPI backend and one PostgreSQL database with logically separated schemas. This provides clear service boundaries without the overhead of several independent microservices.

```mermaid
flowchart TB
    subgraph UI[React + Vite frontend]
      INT[IntelliOps portal]
      PAYUI[Payment Processing portal]
      LEDUI[Core Banking / Ledger portal]
    end
    API[FastAPI REST API + authentication/RBAC]
    UI --> API
    subgraph SERVICES[Backend modules]
      PS[Payment simulator]
      LS[Core banking / ledger simulator]
      WS[Workflow simulator]
      DET[Deterministic detection engine]
      INV[AI investigation / LangGraph]
      POL[Policy and authorization engine]
      ACT[Restricted resolution executor]
      VER[Verification and audit services]
    end
    API --> SERVICES
    PS --> DET
    LS --> DET
    WS --> DET
    DET --> INV
    INV --> POL
    POL -->|Approved permitted action| ACT
    POL -->|Human review needed| API
    ACT --> VER
    subgraph DB[(PostgreSQL)]
      PDB[payments schema]
      LDB[core_banking schema]
      WDB[workflows schema]
      IDB[intelliops schema]
    end
    SERVICES <--> DB
```

**System boundaries:** Source simulators own their respective source records. IntelliOps reads source evidence and issues narrowly scoped, authorized simulator commands. It does not freely mutate payment or accounting records to make reconciliation discrepancies disappear.

### Key integration principle

All portals must reference the same transaction identifiers and database-backed records. For example, `TXN001` in Payment Processing, `payment_ref = TXN001` in Ledger and a linked IntelliOps case refer to the same synthetic event.

## 5. Portals and user interfaces

### 5.1 Global application shell

- Shared global header for **IntelliOps**, **Payment Processing** and **Core Banking / Ledger**.
- Consistent portal switcher, session/avatar area and **Demo · Synthetic Data** indicator.
- Portal-specific dark-navy sidebar with consistent styles and route-aware active state.
- Browser refresh, Back/Forward and portal switching should preserve coherent data and navigation.
- Cross-portal links should open actual referenced records, not fabricated placeholders.

### 5.2 IntelliOps portal

**Overview / Operations Command Center**

- Summary KPIs and trend visualizations, including exception workload, resolutions, pending approval and investigation activity.
- Recent recorded activity; values must be calculated consistently from real case data.
- Demo scenario trigger (permission restricted).

**Exception Center**

- Smart tabs: **All Cases**, **Needs Attention**, **Auto-Resolvable**, **Human Review**, **Closed**.
- Search and filters for severity, status, category, source system, assignee and time range.
- Case table: Case ID, Exception Type, Source System, Severity, Status, Assigned To, Detected At, SLA, Actions.
- Four primary workload KPIs: **Open Cases**, **Investigating**, **Awaiting Approval**, **Closed Today**.
- Case details drawer with **Overview**, **Source Records**, **Activity**, **Actions**.
- Case creation reason/detection rule, evidence, owner, current AI agent, SLA, progression and escalation actions.

**AI Investigation**

- Selected case evidence and agent progress.
- Distinction between observed facts, missing records and AI inference.
- Root-cause hypothesis, supporting evidence and recommended action.
- Explicit uncertainty and human review path where needed.

**Resolution Workflows**

- Visualizes proposed action, deterministic policy decision, required approval, execution and verification.
- A simulation preview must be labeled as a preview; it must not imply that a real corrective action has occurred.
- Shows failures and retry/escalation options without falsely marking steps completed.

**Approval Center**

- Review pending proposals; approve/reject with reasons and actor/time recording.
- Does not permit unapproved actions to execute.

**Audit Trail / Analytics**

- Chronological detection, investigation, assignment, approval, execution, verification and closure records.
- Operational metrics such as median/average resolution duration, successful verified resolutions and human intervention rate.

### 5.3 Payment Processing portal

**Sidebar:** `Transactions` only.

**Transactions page:**

- Summary metrics (total, completed, failed/pending as applicable, linked exceptions).
- Searchable/filterable transaction table with sender/receiver account, amount, currency, processing status and timestamps.
- **Create Synthetic Payment** action with controlled scenario selection.
- Transaction Details drawer with **Overview** and **Processing History** tabs.
- Linked ledger journal and IntelliOps case navigation where records exist.

**Do not create a separate Processing Events page.** The underlying `payment_processing_events` table remains necessary for evidence and is surfaced under the selected transaction's Processing History.

### 5.4 Core Banking / Ledger portal

**Sidebar:** `Accounts` and `Ledger Journals`.

**Accounts**

- Fictional customer and account reference, currency, opening balance, calculated current balance and account status.

**Ledger Journals**

- Journal reference, linked payment reference, posting status/time, debit/credit totals and reconciliation indicator.
- Journal Details drawer lists individual debit/credit entries and linked payment/case evidence.
- No duplicate separate sidebar item required for individual ledger entries.

**Accounting integrity:** A journal can be balanced internally yet fail reconciliation against a payment record. A missing posting must not be displayed as an existing posted journal.

### 5.5 Workflow Engine

Backend simulator only for the initial MVP. It stores processes, tasks, approval requirements, timestamps, retries and error events; IntelliOps monitors these records.

## 6. End-to-end business workflow

```mermaid
flowchart TD
    A[Synthetic source event] --> B[Detection engine evaluates rules]
    B --> C{Exception found?}
    C -->|No| Z[Record normal outcome]
    C -->|Yes| D[Create or update deduplicated case]
    D --> E[Collect source evidence]
    E --> F[AI investigation and recommendation]
    F --> G[Deterministic policy / risk assessment]
    G --> H{Safe and authorized?}
    H -->|Yes| I[Execute restricted action]
    H -->|Approval required| J[Human review]
    H -->|Unsafe / ambiguous| K[Escalate case]
    J -->|Approved| I
    J -->|Rejected| K
    I --> L[Verify actual source-system state]
    L --> M{Verification passed?}
    M -->|Yes| N[Close as Resolved]
    M -->|No| K
    D --> AUD[Audit events]
    E --> AUD
    F --> AUD
    G --> AUD
    J --> AUD
    I --> AUD
    L --> AUD
    N --> AUD
    K --> AUD
```

### Business steps

1. **Generate or receive a synthetic event** — e.g. completed payment, missing expected posting, mismatched amount or failed workflow task.
2. **Detect the exception** — a deterministic rule compares authoritative simulator records, status and processing cutoff. Repeated scans must not create duplicate active cases for the same failure.
3. **Create/assign the case** — source reference, category, exception type, severity, owner/queue and SLA are stored.
4. **Collect evidence** — fetch related payment, ledger or workflow records and identify exactly what was searched and what was missing.
5. **Investigate** — AI summarizes confirmed facts, probable root causes, uncertainty and recommended next steps.
6. **Apply policy** — a deterministic engine decides whether the action is allowed, requires approval or must be escalated. Model confidence alone never authorizes execution.
7. **Resolve or escalate** — execute narrowly scoped low-risk simulator action; otherwise route to human review.
8. **Verify** — reread the affected source record and evaluate expected postconditions.
9. **Close only on justified outcome** — successful verification permits `Closed / Resolved`; a documented false positive may be `Closed / No Action Required`; unsafe or failed cases remain active and assigned/escalated.
10. **Audit and measure** — all decisions, actions, actor identities and timestamps are recorded.

## 7. Source-system business flows

### 7.1 Payment Processing versus Core Banking

These systems both reference transactions but answer different questions:

| System | Primary question | Example record |
|---|---|---|
| Payment Processing | Was a transfer instruction accepted/processed? | `TXN001: Mg Mg -> Su Su, SGD 500, Completed` |
| Core Banking / Ledger | What accounting effects were posted to the relevant accounts? | Journal linked to `TXN001`, with balanced debit/credit entries |
| Workflow Engine | Did the required operational processing steps complete correctly and on time? | Task failed due to a simulated temporary error |

**Illustration:** Mg Mg starts with SGD 1,000 and Su Su with SGD 200. A valid completed SGD 500 transfer can result in balances of SGD 500 and SGD 700, supported by appropriately balanced accounting entries. The example is simplified: in real accounting, customer deposits are bank liabilities and debit/credit directions must follow the account classification.

### 7.2 Payment Processing flow

1. User creates a **synthetic** payment instruction.
2. Simulator creates `payment_transactions` record and processing events.
3. Processing state moves according to the chosen deterministic scenario: Pending -> Processing -> Completed or Failed.
4. For a normal completed transfer, the accounting simulator posts the required balanced journal atomically.
5. For a deliberate exception scenario, the simulator modifies the **scenario conditions**, not real bank records, so a genuine detectable discrepancy exists.
6. IntelliOps detects discrepancies once the configured posting window/cutoff has elapsed.

### 7.3 Ledger accounting flow

1. Fictional customer owns one or more accounts.
2. A ledger **journal** groups the accounting lines for one posting event.
3. Multiple **ledger entries** specify debit/credit amounts and accounts within the journal.
4. A journal can transition to `Posted` only when accounting validations pass; posted lines should be immutable, with subsequent corrections represented by authorized reversal/adjustment journals.
5. Current simulated account balances are derived from opening balances and valid posted entries (or kept in sync atomically if cached).
6. Reconciliation compares a payment's expected financial effects with the actual posted records; matching may need to account for fees, multiple lines, references and currency.

### 7.4 Workflow Engine flow

1. Create a workflow instance.
2. Add ordered/dependent tasks with deadlines, assignment and retry metadata.
3. Record actual state transitions and error events.
4. Detect failures, overdue steps or missing required approval.
5. IntelliOps investigates the task and decides whether a safe idempotent retry is permitted.
6. Retry through an authorized simulator function, reread the task state and verify completion.

## 8. Exception scenarios

### Scenario A — Workflow Processing Failure (**first working autonomous demo**)

**Trigger:** A synthetic task fails with an allowlisted transient service error.

**Evidence:** Task ID, workflow ID, error code, attempt count, execution history, deadline and idempotency declaration.

**Action:** If the task is explicitly idempotent, has no uncertain financial side effects, remains within retry limits and passes authorization checks, run a bounded retry.

**Verification:** Confirm actual task completion; only then close the case. Failed or uncertain outcome leads to investigation/escalation.

### Scenario B — Missing Ledger Posting

**Trigger:** Payment Processing indicates completion but no corresponding ledger posting is found in the declared search scope after the allowed posting cutoff.

**Evidence:** Payment record, processing completion time, expected accounting reference, ledger lookup window/results and related workflow events.

**Action:** Investigate source references and posting delays; safely reconcile metadata only when evidence and rules allow, or escalate to an authorized reviewer.

**Constraint:** Never fabricate financial postings merely to close the exception.

### Scenario C — Amount Mismatch / Unmatched Transaction

**Trigger:** Payment amount/reference does not reconcile against the corresponding **internally balanced** posted journal under configured matching rules.

**Evidence:** Payment amount and currency, journal lines, account references and allowed fees/processing differences.

**Action:** Explain the difference and gather corroborating evidence; require human review for accounting-affecting corrections.

### Scenario D — Missing Required Approval

**Trigger:** A workflow step cannot proceed because an approval is absent or overdue.

**Action:** Route to the correct approver and send a permitted notification; never skip a mandatory approval.

### Deferred scenarios

- **Server down:** Later add service health monitoring, incident correlation, safe recovery/verification and impact analysis.
- **Wrong recipient:** Later support customer-reported payment-recovery cases, evidence gathering and human-controlled follow-ups; never autonomously debit an unintended recipient.

## 9. Exception lifecycle and business rules

### Primary lifecycle statuses

```text
Open -> Investigating -> [Awaiting Approval] -> Resolving -> Closed
             |                  |                |
             +---- Escalation <-+---- Failure ---+
```

- **Open:** Detected and awaiting investigation.
- **Investigating:** Evidence collection and analysis in progress.
- **Awaiting Approval:** Proposed action requires human signoff.
- **Resolving:** Authorized action and/or verification in progress.
- **Closed:** Handling concluded, with explicit closure outcome (`Resolved` or `No Action Required`).

An escalation is a **routing/attention flag**, not a separate primary lifecycle state. Failed verification is an event and flag, not a successful final status. A case should not be marked resolved when a proposal has merely been generated.

### Smart tabs (derived views, not statuses)

| Tab | Selection logic |
|---|---|
| All Cases | All cases within user's access scope |
| Needs Attention | Active cases urgent due to impact, approaching/breached SLA, failed verification or escalation |
| Auto-Resolvable | Active cases currently satisfying the permitted-action and evidence requirements |
| Human Review | Active cases requiring approval or intervention |
| Closed | Closed cases, including Resolved and No Action Required outcomes |

Tabs can overlap; for example a Human Review case may also need attention. Counts must be calculated from a consistent dataset.

### Priority and SLA

Use Critical/High/Medium/Low severity based on configured operational impact and urgency. SLA = a configured service deadline; show time left, overdue duration or whether it was met. Use a consistent simulation clock for reproducible demos.

## 10. AI investigation and autonomous resolution

### Components and responsibilities

| Component | AI? | Responsibility |
|---|---|---|
| Detection Engine | No | Deterministic rules detect exceptions |
| Evidence Collector | Mostly no | Retrieve and validate relevant source records |
| Investigation Agent | Yes | Explain findings, hypotheses and evidence gaps |
| Recommendation Agent | Yes | Suggest low-risk action or escalation |
| Policy Engine | **No** | Enforce allowlists, limits, roles, idempotency and approvals |
| Resolution Executor | No | Execute restricted simulator operations |
| Verification Service | No | Check actual postconditions, re-detect if necessary |
| Audit Service | No | Record actors, policies, evidence and outcomes |

**LangGraph** is proposed for stateful investigation orchestration and human checkpoints. A first milestone can use deterministic Python logic before adding an LLM, reducing demo risk.

### Example workflow retry policy

Retry only when all conditions hold:

- The task type is on an explicit allowlist.
- Its retry operation is idempotent by design.
- The failure code is an approved transient error.
- The system can establish that prior attempts did not create duplicate irreversible effects.
- The retry count remains within the configured limit.
- The case and actor satisfy execution permissions and no required approval is missing.
- The action uses an idempotency key and is recorded before/while executing.

If any required condition cannot be established, **block the action and escalate**.

### AI evidence principles

- Clearly label **verified evidence**, **missing evidence** and **AI interpretation**.
- Report missing records as "not found within search scope/time window," not absolute proof of nonexistence.
- Treat AI recommendations as untrusted proposals until policy validation.
- Do not claim calibrated confidence percentages without a real calibration method.

## 11. Database design

**Recommended database:** PostgreSQL, using four logical schemas. The initial ERD covers **21 entities**.

### 11.1 `payments` (3 entities)

| Entity | Key columns and purpose |
|---|---|
| `payment_transactions` | `payment_id UUID PK`, `transaction_ref VARCHAR(50) UNIQUE`, `sender_account_ref VARCHAR(50)`, `receiver_account_ref VARCHAR(50)`, `amount NUMERIC(18,2)`, `currency CHAR(3)`, `status VARCHAR(30)`, `initiated_at TIMESTAMPTZ`, `completed_at TIMESTAMPTZ NULL`, `created_at TIMESTAMPTZ` |
| `payment_processing_events` | `event_id UUID PK`, `payment_id UUID FK`, `event_type VARCHAR(50)`, `status VARCHAR(30)`, `error_code VARCHAR(50) NULL`, `message TEXT`, `occurred_at TIMESTAMPTZ` |
| `payment_batches` | Optional grouping of payment runs; define columns when batch features are implemented |

### 11.2 `core_banking` (4 entities)

| Entity | Key columns and purpose |
|---|---|
| `customers` | `customer_id UUID PK`, `customer_ref VARCHAR(50) UNIQUE`, `full_name VARCHAR(150)`, `status VARCHAR(20)`, `created_at TIMESTAMPTZ` |
| `accounts` | `account_id UUID PK`, `account_ref VARCHAR(50) UNIQUE`, `customer_id UUID FK`, `currency CHAR(3)`, `opening_balance NUMERIC(18,2)`, `status VARCHAR(20)`, `created_at TIMESTAMPTZ` |
| `ledger_journals` | `journal_id UUID PK`, `journal_ref VARCHAR(50) UNIQUE`, `payment_ref VARCHAR(50) NULL`, `status VARCHAR(20)`, `posted_at TIMESTAMPTZ NULL`, `created_at TIMESTAMPTZ` |
| `ledger_entries` | `entry_id UUID PK`, `journal_id UUID FK`, `account_id UUID FK`, `entry_type VARCHAR(10)`, `amount NUMERIC(18,2)`, `currency CHAR(3)`, `created_at TIMESTAMPTZ` |

**Journal versus entries:** The journal is the overall accounting group; each entry is an individual debit/credit line. Require balanced postings and never edit posted journal lines directly.

### 11.3 `workflows` (4 entities)

| Entity | Key columns and purpose |
|---|---|
| `workflow_instances` | `workflow_id UUID PK`, `workflow_ref VARCHAR(50) UNIQUE`, `workflow_type VARCHAR(50)`, `related_payment_ref VARCHAR(50) NULL`, `status VARCHAR(30)`, `started_at TIMESTAMPTZ`, `completed_at TIMESTAMPTZ NULL` |
| `workflow_tasks` | `task_id UUID PK`, `workflow_id UUID FK`, `task_name VARCHAR(100)`, `status VARCHAR(30)`, `assigned_to_ref VARCHAR(50) NULL`, `retry_count INTEGER`, `max_retries INTEGER`, `is_idempotent BOOLEAN`, `deadline_at TIMESTAMPTZ NULL`, `error_code VARCHAR(50) NULL` |
| `workflow_approvals` | `approval_id UUID PK`, `workflow_id UUID FK`, `task_id UUID FK NULL`, `reviewer_ref VARCHAR(50)`, `status VARCHAR(30)`, `requested_at TIMESTAMPTZ`, `decided_at TIMESTAMPTZ NULL`, `deadline_at TIMESTAMPTZ NULL` |
| `workflow_events` | Append-only task and workflow state changes; define detailed columns during implementation |

### 11.4 `intelliops` (10 entities)

| Entity | Key columns and purpose |
|---|---|
| `users` | `user_id UUID PK`, `full_name VARCHAR(150)`, `email VARCHAR(255) UNIQUE`, `password_hash TEXT`, `role VARCHAR(30)`, `team VARCHAR(100) NULL`, `status VARCHAR(20)` |
| `source_systems` | `source_id UUID PK`, `source_code VARCHAR(50) UNIQUE`, `source_name VARCHAR(100)`, `description TEXT`, `is_active BOOLEAN` |
| `detection_rules` | `rule_id UUID PK`, `rule_code VARCHAR(50)`, `version INTEGER`, `name VARCHAR(150)`, `category VARCHAR(50)`, `exception_type VARCHAR(80)`, `conditions JSONB`, `default_severity VARCHAR(20)`, `is_enabled BOOLEAN`; unique `(rule_code,version)` |
| `exception_cases` | `case_id UUID PK`, `case_ref VARCHAR(50) UNIQUE`, `rule_id UUID FK`, `source_id UUID FK`, `related_record_ref VARCHAR(50) NULL`, `exception_type VARCHAR(80)`, `category VARCHAR(50)`, `severity VARCHAR(20)`, `status VARCHAR(30)`, `assigned_user_id UUID FK NULL`, `assigned_queue VARCHAR(80) NULL`, `sla_deadline_at TIMESTAMPTZ NULL`, `detected_at TIMESTAMPTZ`, `closed_at TIMESTAMPTZ NULL`, `closure_outcome VARCHAR(30) NULL`, `review_required BOOLEAN`, `auto_resolution_eligible BOOLEAN`, timestamps |
| `exception_evidence` | `evidence_id UUID PK`, `case_id UUID FK`, `source_id UUID FK`, `record_ref VARCHAR(50)`, `evidence_type VARCHAR(50)`, `evidence_data JSONB`, `collected_at TIMESTAMPTZ`, `verification_status VARCHAR(30)` |
| `investigations` | `investigation_id UUID PK`, `case_id UUID FK`, `agent_name VARCHAR(100)`, `status VARCHAR(30)`, `root_cause_summary TEXT NULL`, `recommended_action TEXT NULL`, `confidence NUMERIC(5,4) NULL`, timestamps |
| `resolution_actions` | `action_id UUID PK`, `action_code VARCHAR(80) UNIQUE`, `name VARCHAR(150)`, `action_type VARCHAR(50)`, `policy_config JSONB`, `requires_approval BOOLEAN`, `is_enabled BOOLEAN` |
| `resolution_attempts` | `attempt_id UUID PK`, `case_id UUID FK`, `action_id UUID FK`, `idempotency_key VARCHAR(100) UNIQUE`, `status VARCHAR(30)`, `policy_result JSONB`, `execution_result JSONB NULL`, `verification_result JSONB NULL`, timestamps |
| `case_approvals` | `case_approval_id UUID PK`, `case_id UUID FK`, `action_id UUID FK`, `reviewer_id UUID FK NULL`, `status VARCHAR(30)`, `requested_at TIMESTAMPTZ`, `decided_at TIMESTAMPTZ NULL`, `decision_reason TEXT NULL` |
| `audit_events` | `audit_id UUID PK`, `case_id UUID FK NULL`, `actor_type VARCHAR(30)`, `actor_ref VARCHAR(100)`, `event_type VARCHAR(80)`, `details JSONB`, `occurred_at TIMESTAMPTZ` |

The above is a **proposed logical schema**, not already-applied migrations. Some optional or less mature entities (such as `payment_batches` and `workflow_events`) still require detailed design. Additional constraints, indexes, actor identity models and explicit case-to-source-record associations should be added during implementation.

### Key relational links

```mermaid
 erDiagram
    CUSTOMERS ||--o{ ACCOUNTS : owns
    ACCOUNTS ||--o{ LEDGER_ENTRIES : has
    LEDGER_JOURNALS ||--|{ LEDGER_ENTRIES : contains
    PAYMENT_TRANSACTIONS ||--o{ PAYMENT_PROCESSING_EVENTS : generates
    WORKFLOW_INSTANCES ||--o{ WORKFLOW_TASKS : contains
    WORKFLOW_INSTANCES ||--o{ WORKFLOW_APPROVALS : requires
    WORKFLOW_INSTANCES ||--o{ WORKFLOW_EVENTS : records
    SOURCE_SYSTEMS ||--o{ EXCEPTION_CASES : origin
    DETECTION_RULES ||--o{ EXCEPTION_CASES : triggers
    USERS ||--o{ EXCEPTION_CASES : assigned
    EXCEPTION_CASES ||--o{ EXCEPTION_EVIDENCE : holds
    EXCEPTION_CASES ||--o{ INVESTIGATIONS : analyzed
    EXCEPTION_CASES ||--o{ RESOLUTION_ATTEMPTS : resolves
    RESOLUTION_ACTIONS ||--o{ RESOLUTION_ATTEMPTS : executes
    EXCEPTION_CASES ||--o{ CASE_APPROVALS : requests
    EXCEPTION_CASES ||--o{ AUDIT_EVENTS : records
```

**Cross-source links:** `payment_ref`, `transaction_ref` and related record references may be logical business-key correlations rather than direct cross-schema foreign keys. Validate them at service boundaries. Ensure posted journal integrity is enforced transactionally; a UI label is not a substitute for accounting validation.

## 12. Technical stack

| Area | Recommended tool | Notes |
|---|---|---|
| Prototyping | Figma Make | Existing designs and local interactions |
| Frontend | React + Vite | One web app, three portal areas |
| Frontend language | JavaScript / JSX | Matches current team experience; TypeScript optional later |
| Styling | Tailwind CSS | Keep existing generated styles/components where possible |
| Components | Existing components / shadcn/ui | Use shadcn/ui only when helpful; avoid needless rewrites |
| Icons | Lucide React | Consistent icons |
| Navigation | React Router | Stable direct URLs and history |
| Charts | Recharts | Overview and analytics |
| HTTP client | Fetch or Axios | Choose one and standardize |
| Backend | Python 3 + FastAPI | Modular REST services |
| Validation | Pydantic | Typed request/response validation |
| ORM | SQLAlchemy | Database models and queries |
| Migrations | Alembic | Versioned database changes |
| Database | PostgreSQL | Four logical schemas; `NUMERIC` money fields |
| Agent orchestration | LangGraph | Stateful investigation and optional approval checkpoints |
| LLM | OpenAI API (or team-approved equivalent) | Evidence-based explanations/recommendations only |
| Detection/policy | Python deterministic rules | Not delegated to an LLM |
| Resolution | Restricted Python service functions | Safe simulator actions + verification |
| Authentication | JWT/session mechanism + secure password hashing | Enforce server-side RBAC |
| Testing | Pytest, React Testing Library, Playwright | Unit, integration and E2E |
| Containerization | Docker + Docker Compose | Reproducible local demo |
| Version control | Git + GitHub | PRs, protected branches, reviews |
| Optional hosting | Vercel (frontend), Render/Railway (API), managed PostgreSQL | Verify plan limits, sleep behavior and data persistence before demo |

### Not required for MVP

Microservices, Kafka, Kubernetes, n8n, Celery, Redis, RPA bots and live banking connectors are **not essential**. Add them only when a real requirement justifies the operational complexity.

## 13. Repository structure

```text
ocbc-intelliops/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── layouts/
│   │   │   ├── GlobalHeader.jsx
│   │   │   └── PortalSidebar.jsx
│   │   ├── pages/
│   │   │   ├── intelliops/
│   │   │   ├── payments/
│   │   │   └── core-banking/
│   │   ├── services/api.js
│   │   ├── hooks/
│   │   ├── context/
│   │   └── App.jsx
│   ├── package.json
│   └── .env.example
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── api/
│   │   ├── auth/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── simulators/
│   │   │   ├── payment.py
│   │   │   ├── core_banking.py
│   │   │   └── workflow.py
│   │   ├── detection/
│   │   ├── agents/
│   │   ├── policies/
│   │   ├── resolution/
│   │   ├── verification/
│   │   ├── audit/
│   │   └── database.py
│   ├── alembic/
│   ├── tests/
│   ├── requirements.txt
│   └── .env.example
├── database/
│   ├── seed/
│   └── scripts/
├── docs/
│   ├── architecture/
│   ├── erd/
│   └── demo-scenarios/
├── docker-compose.yml
├── .gitignore
└── README.md
```

## 14. Proposed API design

**These are suggested endpoints to implement, not a claim that they already exist.** Prefix with `/api` and apply authentication/authorization to sensitive routes.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/payments` | List synthetic payments |
| `POST` | `/api/payments` | Create permitted synthetic payment |
| `GET` | `/api/payments/{id}` | Transaction details |
| `GET` | `/api/payments/{id}/events` | Processing History for selected payment |
| `GET` | `/api/accounts` | List fictional accounts |
| `GET` | `/api/accounts/{id}` | Account and derived balance |
| `GET` | `/api/ledger/journals` | List journal groups |
| `GET` | `/api/ledger/journals/{id}` | Journal and entries |
| `GET` | `/api/workflows` | List workflow instances |
| `GET` | `/api/workflows/{id}` | Workflow and task details |
| `GET` | `/api/exceptions` | Search/filter cases |
| `GET` | `/api/exceptions/{id}` | Case summary, details and links |
| `POST` | `/api/exceptions/detect` | Trigger authorized scan for demo/testing |
| `POST` | `/api/exceptions/{id}/investigate` | Start/resume investigation |
| `GET` | `/api/exceptions/{id}/evidence` | Return structured evidence |
| `POST` | `/api/exceptions/{id}/proposals` | Create a resolution proposal |
| `POST` | `/api/exceptions/{id}/approvals` | Record authorized reviewer decision |
| `POST` | `/api/exceptions/{id}/resolve` | Attempt allowed action with idempotency key |
| `GET` | `/api/exceptions/{id}/audit` | Retrieve case audit history |
| `POST` | `/api/demo/scenarios` | Create deterministic allowed demo scenario |

### Example case response (illustrative)

```json
{
  "case_ref": "EX-1001",
  "exception_type": "Workflow Failure",
  "category": "Workflow Operations",
  "source_system": "WORKFLOW",
  "related_record_ref": "WF-001",
  "severity": "Medium",
  "status": "Investigating",
  "review_required": false,
  "auto_resolution_eligible": false,
  "detected_at": "2026-03-18T02:15:00Z"
}
```

The example timestamp is synthetic and not a live incident time. Use a fixed simulation clock for repeatable demos and timezone-aware timestamps in storage.

## 15. Security, risk and audit requirements

1. **Synthetic-only data:** Do not store real customer information, banking credentials or production records.
2. **Server-side authorization:** Roles and permission checks are enforced by the backend, not by hiding buttons.
3. **Approval gates:** Sensitive actions require recorded review; no model instruction can override policy.
4. **Action allowlist:** AI cannot invent endpoints or execute arbitrary commands/SQL.
5. **Idempotency and concurrency:** Prevent duplicate retries and simultaneous conflicting resolution attempts.
6. **Financial integrity:** Balanced journals, immutable posted entries and no unauthorized account balance changes.
7. **Auditability:** Append-only event history with actor, timestamp, case, policy decision, execution and verification evidence.
8. **Secrets management:** Store API keys and database credentials outside source code; never expose LLM keys in the browser.
9. **LLM safety:** Treat retrieved source text as data, not executable instructions; validate AI tool arguments and outputs.
10. **Data access:** Limit evidence to appropriate roles and redact sensitive fields even in simulations where useful.
11. **Failure-safe behavior:** On insufficient evidence, policy timeout, LLM outage or uncertain task state, block action and route for human review.
12. **Demo isolation:** Scenario generation and reset endpoints must be restricted to demo/test environments.

## 16. Local setup and configuration plan

> This repository README is currently an **architecture and implementation blueprint**. Commands below are the intended setup workflow after the relevant files are added; they are **not verified working commands for the current Figma Make prototype**.

### Prerequisites

- Recent supported Node.js LTS and npm.
- Supported Python 3.x version.
- PostgreSQL (or Docker Desktop with Docker Compose).
- Git.
- Optional LLM API key for AI explanations.

### Planned environment variables

Create local `.env` files from templates; **never commit actual secrets**.

```dotenv
# backend/.env.example
DATABASE_URL=postgresql+psycopg://intelliops:change_me@localhost:5432/intelliops
JWT_SECRET_KEY=replace-with-long-random-secret
OPENAI_API_KEY=
APP_ENV=development
DEMO_MODE=true
DEMO_CLOCK=2026-03-18T10:30:00+08:00
FRONTEND_ORIGIN=http://localhost:5173
```

```dotenv
# frontend/.env.example
VITE_API_BASE_URL=http://localhost:8000/api
```

### Planned startup sequence

1. Run PostgreSQL (preferably via Docker Compose).
2. Install backend dependencies, configure the database URL and apply Alembic migrations.
3. Seed reproducible fictional customers, accounts, payments, journals, workflow tasks and detection rules.
4. Start FastAPI and verify `/docs` plus health checks.
5. Install frontend dependencies and start the Vite development server.
6. Create a demo scenario, trigger exception detection and check that all portals show the same source references.
7. Execute a permitted resolution and verify database changes, case outcome and audit events.

Do not add precise CLI commands to this document until `package.json`, backend dependency files, migration configuration and Docker Compose have been committed and tested.

## 17. Testing and acceptance criteria

### Backend tests

- Payment creation validates positive amount, currency and account references.
- Synthetic scenario generation is deterministic and reproducible.
- Balanced journal posting is enforced; invalid journals cannot be posted.
- A posting gap after the configured cutoff produces a case; before cutoff it does not.
- Correctly matched payment and ledger records do not trigger false mismatches.
- A repeated detection scan does not create a duplicate open case.
- A workflow retry is blocked for non-idempotent, unauthorized or exhausted tasks.
- An approved retry changes actual simulator state and is independently verified.
- Failed verification never marks the case resolved.
- Reviewer decisions and all execution events appear in audit history.

### Frontend tests

- Shared global navigation works across all three portals.
- IntelliOps sidebar is preserved; Payments has **Transactions**; Ledger has **Accounts** and **Ledger Journals**.
- Transaction Details displays only the selected payment's Processing History.
- Clicking payment/journal/case references opens the correct related record.
- Filters, search, counts, sorting and active navigation are derived from shared data.
- No broken routes after refresh or browser Back/Forward.
- Approval and resolution buttons reflect permission, policy and case status.
- Timestamps and SLA calculations use a consistent demo clock.

### End-to-end MVP definition of done

A judge can:

1. Open a source portal and see a coherent synthetic transaction or workflow.
2. Create a controlled exception.
3. See a matching case appear in IntelliOps.
4. Open the case and inspect the evidence from the source systems.
5. View an investigation and recommended next action.
6. Observe a permitted safe resolution **or** justified human escalation.
7. See verification and corresponding audit records.
8. Confirm the source record and IntelliOps case remain consistent across pages.

## 18. Presentation demonstration script

### Recommended demo 1: verified autonomous workflow retry

1. Show a normal workflow with a known task sequence.
2. Generate a synthetic transient failure for one idempotent task.
3. Open IntelliOps Exception Center and show the detected case.
4. Open AI Investigation and display the observed error, history and recommendation.
5. Show the policy check: permitted error, safe retry, authorized actor, retry limit.
6. Execute the retry through the simulator.
7. Refresh source task state and show that verification succeeded.
8. Show case closure and the audit log of each step.

**Key message:** IntelliOps performs and verifies a controlled resolution rather than merely suggesting a fix.

### Recommended demo 2: cross-system reconciliation

1. Open Payment Processing and show `TXN001` as completed.
2. Open Core Banking / Ledger and inspect the corresponding journal and entries.
3. Generate a Missing Ledger Posting or Amount Mismatch scenario using controlled test data.
4. Return to IntelliOps, trigger detection and open the case.
5. Show the exact difference between expected and observed evidence.
6. Demonstrate escalation or a narrowly approved nonfinancial correction if the scenario supports it.
7. Show the audit history, emphasizing financial integrity and human oversight.

**Key message:** AI gathers and explains evidence across systems while deterministic checks preserve control.

### Presentation cautions

- State clearly that the three portals are **simulated source systems**.
- Do not describe prototype-local state changes as verified backend or real bank actions.
- Do not claim a ledger posting was repaired if only an exception status changed.
- Keep a deterministic demonstration dataset and a safe reset mechanism.
- Prepare a fallback that shows the non-LLM deterministic flow if an API becomes unavailable.

## 19. Implementation roadmap

| Phase | Deliverable | Suggested focus |
|---|---|---|
| **1 — Foundation** | FastAPI project, PostgreSQL schemas, migrations, seeds | Shared source-of-truth data |
| **2 — Source simulators** | Payment, Ledger and Workflow modules with working APIs | Deterministic normal/exception scenarios |
| **3 — Detection** | Rule engine, deduplication, case creation, evidence | Exception Center backed by real API |
| **4 — First resolution** | Idempotent workflow retry, policy check, verification, audit | One complete demonstrable autonomous cycle |
| **5 — AI integration** | LangGraph investigation and recommendations | Explainable evidence-backed analysis |
| **6 — Human controls** | Approval Center, reviewer permissions and escalation | Safe handling of sensitive cases |
| **7 — Full UI integration** | All three portals using same dataset and links | Reliable demo navigation |
| **8 — QA & deployment** | Automated tests, Docker, optional hosted demo | Reproducible presentation |
| **Future** | Server outage, mistaken-transfer recovery and advanced reporting | Only after MVP is stable |

### Recommended order for the next coding session

**First:** Implement the database-backed workflow-task failure and a simple deterministic resolution path. **Second:** Connect the existing Figma frontend to the shared FastAPI data. **Third:** add cross-system reconciliation scenarios and AI investigation.

## 20. Glossary

| Term | Meaning |
|---|---|
| **Exception** | An event or discrepancy requiring investigation or controlled handling |
| **Incident** | An operational disruption, potentially affecting multiple tasks or cases |
| **Payment Processing** | System coordinating and recording transfer instruction processing |
| **Core Banking** | Banking-account systems managing customer accounts and balances |
| **Ledger** | Accounting record of debit/credit movements |
| **Opening Balance** | Account balance at the start of the simulation or accounting period |
| **Journal** | Accounting transaction group containing one or more entries |
| **Ledger Entry** | Individual debit/credit line for a specific account |
| **Reconciliation** | Comparing source and accounting records for completeness and consistency |
| **Workflow Instance** | One execution of a defined operational process |
| **Workflow Task** | One step within a workflow |
| **SLA** | Defined service deadline or target for handling an exception |
| **Idempotency** | Executing the same operation multiple times does not create duplicate intended effects |
| **Escalation** | Routing a case to a human/team with the needed authority or expertise |
| **Human in the loop** | Required human review or approval for certain decisions/actions |
| **Verification** | Rechecking actual system state after an action to confirm its outcome |
| **Audit Trail** | Chronological, attributable record of material events and decisions |
| **Modular monolith** | Single deployable backend with clearly separated internal modules |

---

**Project principle:** *Detect accurately. Investigate with evidence. Act only within policy. Verify the real outcome. Audit every step.*
