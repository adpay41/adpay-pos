-- Phase 5: items created at the register from an unknown barcode (build plan F1/F4).
--
-- The register mints the item id so it can sell the item offline at once. If two registers create
-- the same barcode before either syncs, the server keeps the first item and records the second id
-- as an alias, so sales rung under either id resolve to one item (ADR 0013).

ALTER TABLE items ADD COLUMN origin_register_id uuid REFERENCES registers (register_id);

CREATE TABLE item_aliases (
  alias_item_id  uuid PRIMARY KEY,
  item_id        uuid NOT NULL REFERENCES items (item_id),
  org_id         uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  register_id    uuid REFERENCES registers (register_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX item_aliases_item_idx ON item_aliases (item_id);
