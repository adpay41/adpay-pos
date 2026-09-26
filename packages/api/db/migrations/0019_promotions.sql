-- Phase 20a: promotions (Bible 2.3 promotions builder, 1.5 deals in idle; ADR 0031). Configuration,
-- mutable and audited, delivered to registers in the config snapshot. What a promotion actually gave
-- is in the sales themselves (sale.line_discounted with promo_id), never here.
CREATE TABLE promotions (
  promo_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 48),
  rule          jsonb NOT NULL,
  item_ids      uuid[] NOT NULL DEFAULT '{}',
  category_ids  uuid[] NOT NULL DEFAULT '{}',
  location_ids  uuid[],
  starts_on     date NOT NULL,
  ends_on       date,
  days          int[],
  start_time    text,
  end_time      text,
  show_on_idle  boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX promotions_merchant_idx ON promotions (merchant_id) WHERE active;
CREATE INDEX sale_events_promo_idx ON sale_events ((payload->>'promo_id')) WHERE type = 'sale.line_discounted';
