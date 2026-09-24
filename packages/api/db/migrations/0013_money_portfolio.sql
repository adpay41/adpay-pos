-- Phase 13: statement analyzer, residuals, KPIs (Bible 3.1 L41, 3.3 L50, 3.5 L53; ADR 0022).

-- Prospect statements entered by hand (PDF parsing waits for sample statements, ⛔). A prospect is
-- not a merchant yet, so these rows are platform-level (null tenancy, like admin users).
CREATE TABLE statement_analyses (
  analysis_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry        jsonb NOT NULL,
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  trace_id     text NOT NULL
);

-- Processor cost per merchant-month, typed from the processor's statement until Finix data can be
-- imported (⛔ rate card, settlement files). Corrected by entering it again; every entry is audited.
CREATE TABLE processor_costs (
  org_id                uuid NOT NULL,
  merchant_id           uuid NOT NULL,
  month                 text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  interchange_cents     bigint NOT NULL CHECK (interchange_cents >= 0),
  processor_fees_cents  bigint NOT NULL CHECK (processor_fees_cents >= 0),
  note                  text,
  entered_by            uuid REFERENCES users (user_id),
  entered_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, month),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
