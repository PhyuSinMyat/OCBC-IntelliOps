-- Purpose: durable request reservations and immutable accepted investigation reports.
-- Dependencies: existing public.exceptions(id INTEGER), current application roles.
-- Deployment approval/execution is recorded in AI_INVESTIGATION_PERSISTENCE_DEPLOYMENT.md.
-- No financial tables or records are updated. Do not automatically rerun this script.
BEGIN;
CREATE TABLE public.investigation_records (
    request_id VARCHAR(36) PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES public.exceptions(id),
    created_by VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL,
    investigation_id VARCHAR(50) UNIQUE,
    evidence_fingerprint VARCHAR(64) NOT NULL,
    model VARCHAR(100),
    report JSON,
    error JSON,
    http_status INTEGER,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_investigation_status CHECK (status IN ('RUNNING','ACCEPTED','REJECTED','FAILED','UNKNOWN')),
    CONSTRAINT ck_investigation_report CHECK (
      (status = 'ACCEPTED' AND report IS NOT NULL AND investigation_id IS NOT NULL AND http_status = 200)
      OR (status <> 'ACCEPTED' AND report IS NULL))
);
CREATE INDEX ix_investigation_case_created ON public.investigation_records(case_id, created_at);
CREATE UNIQUE INDEX uq_investigation_running_case ON public.investigation_records(case_id) WHERE status = 'RUNNING';
CREATE FUNCTION public.protect_investigation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'Historical investigation records are immutable';
  END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.evidence_fingerprint IS DISTINCT FROM OLD.evidence_fingerprint THEN
    RAISE EXCEPTION 'Investigation reservation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_investigation_history BEFORE UPDATE OR DELETE ON public.investigation_records
FOR EACH ROW EXECUTE FUNCTION public.protect_investigation_history();
-- Access is through authenticated FastAPI's server DB role; no direct browser access.
ALTER TABLE public.investigation_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.investigation_records FROM anon, authenticated;
COMMIT;
-- Read-only verification after approved execution:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='investigation_records';
-- SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='investigation_records';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.investigation_records'::regclass;
-- SELECT tgname FROM pg_trigger WHERE tgrelid='public.investigation_records'::regclass AND NOT tgisinternal;
