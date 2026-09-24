-- Phase 3: staff, register PINs, roles and permissions (build plan F2).
--
-- A person (users row) can work at several merchants with a different role at each: memberships
-- replace the one-merchant-per-user columns. That is what lets an owner of three stores switch
-- between them (Bible L32), and a cashier who works at two stores have one login.

CREATE TABLE memberships (
  user_id      uuid NOT NULL REFERENCES users (user_id),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  role         text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  -- Register PIN, as `pbkdf2-sha256$iter$salt$hash` (packages/shared/src/staff.ts). Never the PIN.
  -- Per membership, so a person's PIN at one store says nothing about another.
  pin_hash     text CHECK (pin_hash IS NULL OR pin_hash LIKE 'pbkdf2-sha256$%'),
  pin_set_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz,
  PRIMARY KEY (user_id, merchant_id),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX memberships_merchant_idx ON memberships (merchant_id);

INSERT INTO memberships (user_id, org_id, merchant_id, role, created_at, disabled_at)
SELECT user_id, org_id, merchant_id, role, created_at, disabled_at
  FROM users WHERE kind = 'merchant_user';

-- users is now just the person. Tenancy and role live on memberships.
ALTER TABLE users DROP CONSTRAINT users_check;
ALTER TABLE users DROP COLUMN org_id;
ALTER TABLE users DROP COLUMN merchant_id;
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;
UPDATE users SET role = NULL WHERE kind = 'merchant_user';
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_kind_shape CHECK (
  (kind = 'admin' AND role = 'platform_admin' AND email IS NOT NULL)
  OR (kind = 'merchant_user' AND role IS NULL)
);

-- Per-merchant changes to the default permissions of managers and cashiers (owners hold all).
-- Shape validated by PermissionOverridesSchema in packages/shared.
ALTER TABLE merchants ADD COLUMN permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Who was signed in at the register for each event. Envelope field, added to the ledger as a column
-- so per-cashier reports and the compliance log don't dig through payloads. Null for older events.
ALTER TABLE sale_events ADD COLUMN actor_user_id uuid;
CREATE INDEX sale_events_actor_idx ON sale_events (merchant_id, actor_user_id, business_date) WHERE actor_user_id IS NOT NULL;

-- Registers need the staff list in their config snapshot; move every merchant's version once.
UPDATE merchants SET catalog_version = catalog_version + 1;
