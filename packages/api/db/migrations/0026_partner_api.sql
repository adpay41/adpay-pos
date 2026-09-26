-- Phase 25a: partner API keys and webhooks (Bible 3.4; ADR 0039).

-- A key lets a partner read one merchant's data within its scopes. Only a hash of the key is kept;
-- the key itself is shown once, when it is created.
CREATE TABLE api_keys (
  key_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  prefix        text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{8}$'),
  key_hash      text NOT NULL,
  scopes        text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by    uuid REFERENCES users (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users (user_id),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id, created_at DESC);

-- Where a merchant's events are pushed. The signing secret is ours (generated here) and is needed to
-- sign every delivery, so it is kept; it is shown once and can be rotated.
CREATE TABLE webhook_endpoints (
  endpoint_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  url           text NOT NULL,
  description   text NOT NULL DEFAULT '',
  events        text[] NOT NULL CHECK (cardinality(events) > 0),
  secret        text NOT NULL,
  created_by    uuid REFERENCES users (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id) WHERE disabled_at IS NULL;

-- One row per (endpoint, event): the delivery queue and its outcome. Retries update the row.
CREATE TABLE webhook_deliveries (
  delivery_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id       uuid NOT NULL REFERENCES webhook_endpoints (endpoint_id),
  merchant_id       uuid NOT NULL,
  event_id          uuid NOT NULL,
  event_type        text NOT NULL,
  body              jsonb NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  last_status_code  integer,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
