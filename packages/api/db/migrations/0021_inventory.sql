-- Phase 22: inventory (Bible 1.9, 2.4; ADR 0034). Stock is folded from counts, receipts, write-offs
-- and sales; nothing stores an editable on-hand number. Every movement, from the register (its
-- inventory.* events) or the merchant app, is one append-only row here.
ALTER TABLE items ADD COLUMN track_stock boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN reorder_point integer CHECK (reorder_point >= 0);
ALTER TABLE items ADD COLUMN stock_of uuid REFERENCES items (item_id);
ALTER TABLE items ADD COLUMN stock_ratio integer NOT NULL DEFAULT 1 CHECK (stock_ratio >= 1);
ALTER TABLE items ADD COLUMN perishable boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD CONSTRAINT items_stock_of_not_self CHECK (stock_of IS NULL OR stock_of <> item_id);

CREATE TABLE inventory_movements (
  movement_id    uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  location_id    uuid NOT NULL,
  item_id        uuid NOT NULL REFERENCES items (item_id),
  kind           text NOT NULL CHECK (kind IN ('count', 'receive', 'adjust')),
  -- count: units on the shelf; receive: units in (> 0); adjust: signed change (a write-off is < 0)
  qty            integer NOT NULL,
  reason         text,
  note           text,
  invoice_ref    text,
  expires_on     date,
  receipt_id     uuid,
  source         text NOT NULL CHECK (source IN ('register', 'app')),
  register_id    uuid,
  actor_user_id  uuid,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  trace_id       text NOT NULL,
  FOREIGN KEY (org_id, merchant_id, location_id) REFERENCES locations (org_id, merchant_id, location_id),
  CHECK (kind <> 'receive' OR qty > 0),
  CHECK (kind <> 'count' OR qty >= 0)
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (merchant_id, location_id, item_id, occurred_at);
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
