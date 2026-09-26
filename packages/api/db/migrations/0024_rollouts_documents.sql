-- Phase 24b: staged flag rollouts with a kill switch (Bible 3.2) and the documents vault (Bible 2.8).
-- ADR 0037.

-- Every change of a flag's platform-wide stage. Append-only: the current stage is the latest row.
CREATE TABLE flag_rollouts (
  rollout_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag                 text NOT NULL,
  stage                text NOT NULL CHECK (stage IN ('default', 'canary', 'ten_percent', 'all', 'killed')),
  canary_merchant_ids  uuid[] NOT NULL DEFAULT '{}',
  reason               text NOT NULL,
  set_by               uuid REFERENCES users (user_id),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  trace_id             text NOT NULL
);
CREATE INDEX flag_rollouts_flag_idx ON flag_rollouts (flag, created_at DESC);
CREATE TRIGGER flag_rollouts_append_only BEFORE UPDATE OR DELETE ON flag_rollouts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A store document: the file and what it is. Immutable; a renewal is a new row that replaces this one.
CREATE TABLE documents (
  document_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  location_id   uuid REFERENCES locations (location_id),
  kind          text NOT NULL,
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  expires_on    date,
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size     integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5000000),
  sha256        text NOT NULL,
  bytes         bytea NOT NULL,
  replaces      uuid REFERENCES documents (document_id),
  uploaded_by   uuid REFERENCES users (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  trace_id      text NOT NULL,
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX documents_merchant_idx ON documents (merchant_id, created_at DESC);
CREATE INDEX documents_expiry_idx ON documents (expires_on) WHERE expires_on IS NOT NULL;
CREATE TRIGGER documents_immutable BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Taking a document out of the vault (replaced by a renewal, or no longer needed). Append-only.
CREATE TABLE document_archives (
  document_id  uuid PRIMARY KEY REFERENCES documents (document_id),
  reason       text NOT NULL CHECK (reason IN ('replaced', 'removed')),
  archived_by  uuid REFERENCES users (user_id),
  archived_at  timestamptz NOT NULL DEFAULT now(),
  trace_id     text NOT NULL
);
CREATE TRIGGER document_archives_append_only BEFORE UPDATE OR DELETE ON document_archives FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
