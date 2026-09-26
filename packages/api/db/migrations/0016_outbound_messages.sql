-- Phase 18b: receipts sent later by text or email (Bible 1.6; ADR 0028). Every message the platform
-- sends to a person is recorded here, whoever delivers it. The recipient is stored masked plus a
-- salted hash (to count repeats), never in full: the sender gets the full address once, in memory.
CREATE TABLE outbound_messages (
  message_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid,
  channel      text NOT NULL CHECK (channel IN ('sms', 'email')),
  purpose      text NOT NULL CHECK (purpose IN ('receipt')),
  to_masked    text NOT NULL,
  to_hash      text NOT NULL,
  sale_id      uuid,
  provider     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('sent', 'logged', 'failed')),
  provider_ref text,
  error        text,
  created_by   uuid REFERENCES users (user_id),
  trace_id     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX outbound_messages_merchant_idx ON outbound_messages (merchant_id, created_at DESC);
CREATE INDEX outbound_messages_sale_idx ON outbound_messages (sale_id, created_at DESC);

-- A digital-receipt link for a sale rung without one (digital receipts off, or before P18). The
-- sale's events are never touched; the link lives beside them.
CREATE TABLE receipt_links (
  token        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  sale_id      uuid NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
