-- Phase 23: vendors, purchase orders, reorder suggestions (Bible 2.4; ADR 0035).
CREATE TABLE vendors (
  vendor_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  phone          text,
  email          text,
  order_via      text NOT NULL CHECK (order_via IN ('sms', 'email')),
  delivery_days  int[] NOT NULL DEFAULT '{}',
  note           text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX vendors_merchant_idx ON vendors (merchant_id);

-- Who supplies an item (its primary vendor): what the reorder suggestions group by.
ALTER TABLE items ADD COLUMN vendor_id uuid REFERENCES vendors (vendor_id);

-- A purchase order: a draft is edited, "sent" goes to the rep, receiving against it (at the register)
-- is recorded as inventory movements carrying po_id; what arrived vs what was ordered is read from them.
CREATE TABLE purchase_orders (
  po_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  location_id    uuid NOT NULL,
  vendor_id      uuid NOT NULL REFERENCES vendors (vendor_id),
  status         text NOT NULL CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  lines          jsonb NOT NULL,
  note           text,
  created_by     uuid REFERENCES users (user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  send_status    text,
  closed_at      timestamptz,
  FOREIGN KEY (org_id, merchant_id, location_id) REFERENCES locations (org_id, merchant_id, location_id)
);
CREATE INDEX purchase_orders_merchant_idx ON purchase_orders (merchant_id, status, created_at DESC);

ALTER TABLE inventory_movements ADD COLUMN po_id uuid;

ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_purpose_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_purpose_check CHECK (purpose IN ('receipt', 'promo', 'order'));
