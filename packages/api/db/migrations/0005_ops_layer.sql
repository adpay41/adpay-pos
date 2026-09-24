-- Phase 4: the ops layer (spec step 3, build plan F3). Heartbeats, device logs, remote actions,
-- alerts, and change notifications for the WebSocket channel.

-- Latest known state of each register: one row, replaced by every heartbeat.
CREATE TABLE register_status (
  register_id        uuid PRIMARY KEY REFERENCES registers (register_id),
  org_id             uuid NOT NULL,
  merchant_id        uuid NOT NULL,
  location_id        uuid NOT NULL,
  last_heartbeat_at  timestamptz NOT NULL,
  app_version        text NOT NULL,
  platform           text NOT NULL,
  -- The full last heartbeat, validated by HeartbeatInput in packages/shared.
  heartbeat          jsonb NOT NULL,
  ws_connected       boolean NOT NULL DEFAULT false,
  trace_id           text NOT NULL
);
CREATE INDEX register_status_merchant_idx ON register_status (merchant_id);

-- Heartbeat history for the device page and investigations. Operational data, not ledger: the
-- maintenance job prunes rows older than 7 days.
CREATE TABLE register_heartbeats (
  register_id  uuid NOT NULL REFERENCES registers (register_id),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat    jsonb NOT NULL,
  trace_id     text NOT NULL
);
CREATE INDEX register_heartbeats_idx ON register_heartbeats (register_id, received_at DESC);

-- Log lines a register uploaded on request (its local ring holds the last 10k).
CREATE TABLE device_log_uploads (
  upload_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id  uuid NOT NULL REFERENCES registers (register_id),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  action_id    uuid,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  line_count   integer NOT NULL,
  lines        jsonb NOT NULL,
  trace_id     text NOT NULL
);
CREATE INDEX device_log_uploads_idx ON device_log_uploads (register_id, uploaded_at DESC);

-- Remote actions: queued by the office → delivered to the register (WebSocket or heartbeat reply)
-- → a result reported back. Every request is also in audit_log.
CREATE TABLE remote_actions (
  action_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id   uuid NOT NULL REFERENCES registers (register_id),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  kind          text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'delivered', 'succeeded', 'failed', 'unsupported', 'expired')),
  requested_by  uuid REFERENCES users (user_id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '1 day',
  delivered_at  timestamptz,
  completed_at  timestamptz,
  result        jsonb,
  trace_id      text NOT NULL
);
CREATE INDEX remote_actions_pending_idx ON remote_actions (register_id, requested_at) WHERE status IN ('queued', 'delivered');
CREATE INDEX remote_actions_register_idx ON remote_actions (register_id, requested_at DESC);

-- Alerts from the rule engine. One open alert per dedupe key; re-seeing it bumps last_seen_at.
CREATE TABLE alerts (
  alert_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule              text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  dedupe_key        text NOT NULL,
  title             text NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  org_id            uuid,
  merchant_id       uuid,
  location_id       uuid,
  register_id       uuid,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES users (user_id),
  trace_id          text NOT NULL
);
CREATE UNIQUE INDEX alerts_open_dedupe_idx ON alerts (dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_open_idx ON alerts (merchant_id, opened_at DESC) WHERE resolved_at IS NULL;

-- Change notifications for the realtime channel (LISTEN/NOTIFY: delivered on commit, and to every
-- API instance, so a price change or a remote action reaches a register connected to any of them).
CREATE FUNCTION notify_catalog_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.catalog_version IS DISTINCT FROM OLD.catalog_version THEN
    PERFORM pg_notify('adpay_catalog', json_build_object('merchant_id', NEW.merchant_id, 'catalog_version', NEW.catalog_version)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchants_catalog_notify AFTER UPDATE OF catalog_version ON merchants
  FOR EACH ROW EXECUTE FUNCTION notify_catalog_version();

CREATE FUNCTION notify_remote_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('adpay_action', json_build_object('action_id', NEW.action_id, 'register_id', NEW.register_id)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER remote_actions_notify AFTER INSERT ON remote_actions
  FOR EACH ROW EXECUTE FUNCTION notify_remote_action();
