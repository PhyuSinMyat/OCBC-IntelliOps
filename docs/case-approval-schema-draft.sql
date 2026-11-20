-- Review draft only. Validate on a disposable PostgreSQL database.
-- A deployable migration must be separately approved and must provision API access.
BEGIN;

CREATE TABLE case_resolution_plans (
    id uuid PRIMARY KEY,
    case_id integer NOT NULL UNIQUE REFERENCES exceptions (id),
    UNIQUE (id, case_id)
);

CREATE TABLE case_resolution_plan_versions (
    plan_id uuid NOT NULL,
    case_id integer NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    investigation_id varchar(50) NOT NULL REFERENCES investigation_records (investigation_id),
    evidence_snapshot_ref text NOT NULL CHECK (length(btrim(evidence_snapshot_ref)) > 0),
    verified_customer_context jsonb NOT NULL CHECK (jsonb_typeof(verified_customer_context) = 'object'),
    proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
    author_subject text NOT NULL CHECK (length(btrim(author_subject)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_id, version),
    UNIQUE (case_id, plan_id, version),
    FOREIGN KEY (plan_id, case_id) REFERENCES case_resolution_plans (id, case_id)
);

CREATE TABLE case_policy_assessments (
    id uuid PRIMARY KEY,
    case_id integer NOT NULL,
    plan_id uuid NOT NULL,
    plan_version integer NOT NULL,
    evidence_snapshot_ref text NOT NULL CHECK (length(btrim(evidence_snapshot_ref)) > 0),
    outcome text NOT NULL CHECK (outcome IN ('BLOCKED', 'REVIEW_REQUIRED', 'ELIGIBLE', 'APPROVAL_REQUIRED')),
    findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'object'),
    assessed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, case_id, plan_id, plan_version),
    FOREIGN KEY (case_id, plan_id, plan_version)
        REFERENCES case_resolution_plan_versions (case_id, plan_id, version)
);

CREATE TABLE case_approval_requests (
    id uuid PRIMARY KEY,
    case_id integer NOT NULL,
    plan_id uuid NOT NULL,
    plan_version integer NOT NULL,
    assessment_id uuid NOT NULL,
    submitter_subject text NOT NULL CHECK (length(btrim(submitter_subject)) > 0),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
    UNIQUE (id, status),
    FOREIGN KEY (assessment_id, case_id, plan_id, plan_version)
        REFERENCES case_policy_assessments (id, case_id, plan_id, plan_version)
);

CREATE UNIQUE INDEX uq_case_approval_pending
    ON case_approval_requests (case_id) WHERE status = 'PENDING_APPROVAL';

CREATE TABLE case_approval_decisions (
    request_id uuid PRIMARY KEY,
    outcome text NOT NULL CHECK (outcome IN ('APPROVED', 'REJECTED')),
    administrator_subject text NOT NULL CHECK (length(btrim(administrator_subject)) > 0),
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    decided_at timestamptz NOT NULL DEFAULT now(),
    audit_event_id integer NOT NULL UNIQUE REFERENCES audit_events (id),
    FOREIGN KEY (request_id, outcome) REFERENCES case_approval_requests (id, status)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE case_resolution_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_resolution_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_policy_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_approval_decisions ENABLE ROW LEVEL SECURITY;

ROLLBACK;
