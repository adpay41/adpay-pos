-- AD Pay POS — foundation schema (build step 1).
--
-- Tenancy: org → merchant → location → register. Each table's primary key is named for its level
-- (org_id, merchant_id, …) and every row below the org carries every tenancy id above it, so any
-- row can be scoped without a join. Platform staff (AD Pay admins) have null tenancy by design.
--
-- Money is BIGINT cents. Rates are INTEGER parts-per-million (6.625% = 66250). No float or
-- numeric money column exists anywhere (ADR 0004).

-- ─────────────────────────────────────────────────────────────── tenancy ──

CREATE TABLE orgs (
  org_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  merchant_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs (org_id),
  name             text NOT NULL,
  legal_name       text,
  enabled_packs    text[] NOT NULL DEFAULT ARRAY['cstore'],
  catalog_version  bigint NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, merchant_id),
  CHECK (enabled_packs <@ ARRAY['cstore', 'liquor', 'restaurant', 'grocery'])
);

CREATE TABLE locations (
  location_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  merchant_id          uuid NOT NULL,
  name                 text NOT NULL,
  address_line1        text,
  city                 text,
  state                text,
  postal_code          text,
  timezone             text NOT NULL DEFAULT 'America/New_York',
  tax_rate_ppm         integer NOT NULL CHECK (tax_rate_ppm BETWEEN 0 AND 1000000),
  dual_price_rate_ppm  integer NOT NULL DEFAULT 0 CHECK (dual_price_rate_ppm BETWEEN 0 AND 1000000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, merchant_id, location_id),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);

CREATE TABLE registers (
  register_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'unpaired' CHECK (status IN ('unpaired', 'active', 'retired')),
  paired_at     timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, merchant_id, location_id, register_id),
  FOREIGN KEY (org_id, merchant_id, location_id) REFERENCES locations (org_id, merchant_id, location_id)
);

-- ─────────────────────────────────────────────────────────────── auth ──

-- One table for humans. kind=admin → AD Pay staff (null tenancy, cross-tenant by role);
-- kind=merchant_user → scoped to exactly one merchant.
CREATE TABLE users (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('admin', 'merchant_user')),
  org_id         uuid REFERENCES orgs (org_id),
  merchant_id    uuid REFERENCES merchants (merchant_id),
  role           text NOT NULL CHECK (role IN ('platform_admin', 'owner', 'manager', 'cashier')),
  name           text NOT NULL,
  email          text UNIQUE,
  phone          text UNIQUE,
  password_hash  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,
  CHECK (
    (kind = 'admin' AND org_id IS NULL AND merchant_id IS NULL AND role = 'platform_admin' AND email IS NOT NULL)
    OR (kind = 'merchant_user' AND org_id IS NOT NULL AND merchant_id IS NOT NULL AND role <> 'platform_admin')
  )
);

-- Phone OTP for merchant users. Only a hash of the code is stored.
CREATE TABLE otp_challenges (
  challenge_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, created_at DESC);

-- One-time codes a new register exchanges for its identity (the setup QR encodes one in step 4).
CREATE TABLE register_setup_codes (
  code_hash    text PRIMARY KEY,
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  register_id  uuid NOT NULL REFERENCES registers (register_id),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Long-lived, revocable register credentials. Only a SHA-256 of the token is stored.
CREATE TABLE device_tokens (
  token_hash    text PRIMARY KEY,
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  register_id   uuid NOT NULL REFERENCES registers (register_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE INDEX device_tokens_register_idx ON device_tokens (register_id);

-- ─────────────────────────────────────────────────────────────── catalog ──

CREATE TABLE categories (
  category_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  name         text NOT NULL,
  sort         integer NOT NULL DEFAULT 0,
  taxable      boolean NOT NULL DEFAULT true,
  min_age      integer CHECK (min_age IS NULL OR min_age BETWEEN 1 AND 99),
  color        text,
  pack         text NOT NULL DEFAULT 'cstore',
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX categories_merchant_idx ON categories (merchant_id, sort);

CREATE TABLE items (
  item_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  merchant_id       uuid NOT NULL,
  category_id       uuid REFERENCES categories (category_id),
  name              text NOT NULL,
  sku               text,
  upc               text,
  cash_price_cents  bigint NOT NULL CHECK (cash_price_cents >= 0),
  -- Explicit posted card price. NULL → derived from the location's dual_price_rate_ppm.
  card_price_cents  bigint CHECK (card_price_cents IS NULL OR card_price_cents >= 0),
  sell_unit         text NOT NULL DEFAULT 'each' CHECK (sell_unit IN ('each', 'pack')),
  pack_qty          integer NOT NULL DEFAULT 1 CHECK (pack_qty >= 1),
  -- Pack-specific attributes (validated by the pack), so the core never assumes one vertical.
  attrs             jsonb NOT NULL DEFAULT '{}'::jsonb,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX items_merchant_idx ON items (merchant_id, category_id);
CREATE UNIQUE INDEX items_merchant_upc_idx ON items (merchant_id, upc) WHERE upc IS NOT NULL;

-- ─────────────────────────────────────────────────────────────── sale events ──

-- Global idempotency for event ingest. A partitioned table can only enforce uniqueness together
-- with its partition key, so the device-generated event_id is made globally unique here, in the
-- same transaction as the insert into sale_events. Replaying a batch is a no-op by construction.
CREATE TABLE sale_event_ids (
  event_id     uuid PRIMARY KEY,
  register_id  uuid NOT NULL,
  received_at  timestamptz NOT NULL
);

-- The immutable ledger (ADR 0002). Partitioned by month of server receive time, which is
-- monotonic, so only the current and next month ever take writes.
CREATE TABLE sale_events (
  event_id        uuid NOT NULL,
  org_id          uuid NOT NULL,
  merchant_id     uuid NOT NULL,
  location_id     uuid NOT NULL,
  register_id     uuid NOT NULL,
  sale_id         uuid,
  device_seq      bigint NOT NULL,
  type            text NOT NULL,
  schema_version  integer NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- Server-assigned: the location-local date of occurred_at unless the device clock is implausible.
  business_date   date NOT NULL,
  payload         jsonb NOT NULL,
  trace_id        text NOT NULL,
  PRIMARY KEY (event_id, received_at)
) PARTITION BY RANGE (received_at);

CREATE INDEX sale_events_sale_idx ON sale_events (sale_id, device_seq);
CREATE INDEX sale_events_register_idx ON sale_events (register_id, device_seq);
CREATE INDEX sale_events_merchant_day_idx ON sale_events (merchant_id, business_date, type);
-- "Latest tickets" lists start from each sale's opening event.
CREATE INDEX sale_events_opened_idx ON sale_events (merchant_id, occurred_at DESC) WHERE type = 'sale.opened';

-- Nothing rewrites or deletes a sale event. Corrections are new events.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER sale_events_immutable
  BEFORE UPDATE OR DELETE ON sale_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_events_no_truncate
  BEFORE TRUNCATE ON sale_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_event_ids_immutable
  BEFORE UPDATE OR DELETE ON sale_event_ids
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Creates the monthly partition containing `at` if it does not exist. Called by the maintenance job
-- (ahead of each month boundary) and defensively by ingest before a write to a new month.
CREATE FUNCTION ensure_sale_events_partition(at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  month_start date := date_trunc('month', at AT TIME ZONE 'UTC')::date;
  month_end   date := (month_start + interval '1 month')::date;
  part        text := format('sale_events_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF sale_events FOR VALUES FROM (%L) TO (%L)',
      part, month_start::timestamp AT TIME ZONE 'UTC', month_end::timestamp AT TIME ZONE 'UTC'
    );
  END IF;
  RETURN part;
END;
$$;

SELECT ensure_sale_events_partition(now());
SELECT ensure_sale_events_partition(now() + interval '1 month');

-- ─────────────────────────────────────────────────────────────── audit ──

-- Every admin action (spec: admin → audit log). Append-only like the ledger.
CREATE TABLE audit_log (
  audit_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,
  actor_kind     text NOT NULL,
  action         text NOT NULL,
  org_id         uuid,
  merchant_id    uuid,
  location_id    uuid,
  register_id    uuid,
  target         text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id       text NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
