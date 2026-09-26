-- Phase 19a: loyalty by phone number and the customer list (Bible 1.5, 2.7; ADR 0029).
-- The event log never holds a phone number: sales carry a keyed hash (customer_ref) made with this
-- merchant's salt. `customers` is mutable configuration beside the ledger: the ref, the last four
-- digits, and the number itself only for customers who opted in to texts (with the consent text).
ALTER TABLE merchants ADD COLUMN loyalty_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE merchants ADD COLUMN loyalty_salt text NOT NULL
  DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

CREATE TABLE customers (
  org_id              uuid NOT NULL,
  merchant_id         uuid NOT NULL,
  customer_ref        text NOT NULL CHECK (customer_ref ~ '^[0-9a-f]{64}$'),
  last4               text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  first_seen_at       timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  -- Present only while the customer is opted in to texts; cleared on opt-out.
  phone_e164          text CHECK (phone_e164 ~ '^\+1[0-9]{10}$'),
  marketing_opt_in_at timestamptz,
  consent_version     text,
  consent_text        text,
  opt_in_register_id  uuid,
  opted_out_at        timestamptz,
  opt_out_source      text CHECK (opt_out_source IN ('merchant', 'customer_reply')),
  PRIMARY KEY (merchant_id, customer_ref),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX customers_opted_in_idx ON customers (merchant_id) WHERE phone_e164 IS NOT NULL AND opted_out_at IS NULL;

-- A customer's sales, for their balance.
CREATE INDEX sale_events_customer_ref_idx ON sale_events ((payload->>'customer_ref'))
  WHERE type IN ('sale.customer_identified', 'sale.loyalty_redeemed');

-- Promotional texts go through the same record as receipts.
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_purpose_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_purpose_check CHECK (purpose IN ('receipt', 'promo'));
