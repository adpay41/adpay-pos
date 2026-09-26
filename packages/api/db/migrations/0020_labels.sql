-- Phase 21: shelf tags and labels (Bible 1.6, 2.3, 3.4; ADR 0033).
-- Label templates are merchant configuration. `shelf_tag_prints` remembers the prices each item's tag
-- showed when last printed, so the print queue is "tags whose price changed since".
CREATE TABLE label_templates (
  template_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  settings     jsonb NOT NULL,
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX label_templates_merchant_idx ON label_templates (merchant_id);

CREATE TABLE shelf_tag_prints (
  org_id            uuid NOT NULL,
  merchant_id       uuid NOT NULL,
  item_id           uuid NOT NULL REFERENCES items (item_id),
  cash_price_cents  integer NOT NULL,
  card_price_cents  integer NOT NULL,
  printed_at        timestamptz NOT NULL DEFAULT now(),
  printed_by        uuid REFERENCES users (user_id),
  PRIMARY KEY (merchant_id, item_id),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
