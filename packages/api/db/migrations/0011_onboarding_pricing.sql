-- Phase 12a: onboarding wizard, install kits, pricing plans (Bible 3.1 L42/L43, 3.3 L51; ADR 0020).

-- What AD Pay charges a merchant. Append-only: a new plan is a new row with its effective date, so
-- the history is the table (validated by PricingPlanInput in packages/shared; rates ppm, money cents).
CREATE TABLE merchant_pricing_plans (
  plan_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  merchant_id     uuid NOT NULL,
  plan            jsonb NOT NULL,
  effective_from  date NOT NULL,
  created_by      uuid REFERENCES users (user_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  trace_id        text NOT NULL,
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX merchant_pricing_plans_idx ON merchant_pricing_plans (merchant_id, effective_from DESC, created_at DESC);

CREATE TRIGGER merchant_pricing_plans_append_only BEFORE UPDATE OR DELETE ON merchant_pricing_plans
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Where a merchant is in onboarding. KYB runs through the processor (⛔ until the AD Pay LLC account).
CREATE TABLE merchant_onboarding (
  merchant_id    uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  status         text NOT NULL DEFAULT 'setting_up' CHECK (status IN ('setting_up', 'ready_to_install', 'live')),
  kyb_status     text NOT NULL DEFAULT 'not_started' CHECK (kyb_status IN ('not_started', 'submitted', 'approved', 'declined')),
  install_date   date,
  hardware_note  text,
  created_by     uuid REFERENCES users (user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);

-- Merchants that existed before the wizard are already selling.
INSERT INTO merchant_onboarding (merchant_id, org_id, status)
SELECT merchant_id, org_id, 'live' FROM merchants
ON CONFLICT DO NOTHING;
