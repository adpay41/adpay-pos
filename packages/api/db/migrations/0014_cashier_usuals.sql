-- Phase 14: cashier presets — "the usual" (Bible 1.1). A cashier's regular baskets ("Mike: medium
-- coffee + Newports"), saved at the register and delivered to every register of the store in the
-- config snapshot (server wins, like the catalog). Mutable configuration, audited; not ledger.
CREATE TABLE cashier_usuals (
  usual_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users (user_id),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  lines        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX cashier_usuals_merchant_idx ON cashier_usuals (merchant_id, user_id, created_at);
