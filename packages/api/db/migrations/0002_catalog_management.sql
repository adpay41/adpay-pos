-- Phase 1: catalog management (build plan F1).
--
-- Every catalog write bumps merchants.catalog_version in the same transaction, so registers can
-- tell cheaply that their snapshot is stale. Price changes are recorded append-only in
-- item_price_history from day one (the Bible's "price history and who changed what" is N; the data
-- starts now so that history exists when the UI arrives).

ALTER TABLE items
  ADD COLUMN plu         text,
  ADD COLUMN open_price  boolean NOT NULL DEFAULT false,
  ADD COLUMN cost_cents  bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  ADD COLUMN updated_by  uuid REFERENCES users (user_id);

CREATE UNIQUE INDEX items_merchant_plu_idx ON items (merchant_id, plu) WHERE plu IS NOT NULL;

ALTER TABLE categories
  ADD COLUMN active boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX categories_merchant_name_idx ON categories (merchant_id, lower(name));

-- Additional barcodes per item: a case/carton UPC that sells the item as a pack, alternate UPCs.
-- (items.upc stays the primary barcode.)
CREATE TABLE item_barcodes (
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  item_id      uuid NOT NULL REFERENCES items (item_id),
  barcode      text NOT NULL,
  pack_qty     integer NOT NULL DEFAULT 1 CHECK (pack_qty >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, barcode),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);

-- Append-only record of every price change (cash, explicit card, cost).
CREATE TABLE item_price_history (
  history_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  merchant_id       uuid NOT NULL,
  item_id           uuid NOT NULL REFERENCES items (item_id),
  cash_price_cents  bigint NOT NULL,
  card_price_cents  bigint,
  cost_cents        bigint,
  catalog_version   bigint NOT NULL,
  changed_by        uuid REFERENCES users (user_id),
  changed_by_kind   text NOT NULL,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  trace_id          text NOT NULL
);
CREATE INDEX item_price_history_item_idx ON item_price_history (item_id, changed_at DESC);
CREATE TRIGGER item_price_history_immutable
  BEFORE UPDATE OR DELETE ON item_price_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Seed history rows for items that already exist, so every item has a starting point.
INSERT INTO item_price_history (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, cost_cents,
                                catalog_version, changed_by, changed_by_kind, changed_at, trace_id)
SELECT i.org_id, i.merchant_id, i.item_id, i.cash_price_cents, i.card_price_cents, NULL,
       m.catalog_version, NULL, 'migration', i.created_at, 'migration-0002'
  FROM items i JOIN merchants m ON m.merchant_id = i.merchant_id;
