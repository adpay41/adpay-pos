-- Phase 12b: feature flags per merchant and support chat (Bible 3.4 L52, 2.8 L40; ADR 0021).

-- Overrides over the defaults in packages/shared/src/flags.ts; '{}' = everything as designed.
ALTER TABLE merchants ADD COLUMN feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One conversation per merchant with AD Pay support. Messages are append-only like the ledger.
CREATE TABLE support_messages (
  message_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  merchant_id     uuid NOT NULL,
  author_kind     text NOT NULL CHECK (author_kind IN ('merchant_user', 'admin')),
  author_user_id  uuid REFERENCES users (user_id),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  trace_id        text NOT NULL,
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX support_messages_merchant_idx ON support_messages (merchant_id, created_at);
CREATE TRIGGER support_messages_append_only BEFORE UPDATE OR DELETE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- How far each side has read, for unread counts.
CREATE TABLE support_reads (
  merchant_id   uuid NOT NULL REFERENCES merchants (merchant_id),
  side          text NOT NULL CHECK (side IN ('merchant', 'admin')),
  last_read_at  timestamptz NOT NULL,
  PRIMARY KEY (merchant_id, side)
);
