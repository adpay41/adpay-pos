-- Phase 9: card payments through the PaymentProvider (stub today, Finix later — ADR 0003).
--
-- Every charge and refund sent to the processor, keyed by the id the register minted (tender_id or
-- refund_id). A retry with the same key returns the stored result and never reaches the processor
-- again, so a lost response can't turn into a double charge. No card data: brand, last four, the
-- processor's opaque reference and the outcome only.
CREATE TABLE payment_attempts (
  idempotency_key  uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('charge', 'refund')),
  org_id           uuid NOT NULL,
  merchant_id      uuid NOT NULL,
  location_id      uuid NOT NULL,
  register_id      uuid NOT NULL REFERENCES registers (register_id),
  sale_id          uuid NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  provider         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('approved', 'declined', 'pending', 'error')),
  provider_ref     text,
  approval_code    text,
  brand            text,
  last4            text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  message          text,
  -- For a refund: the charge it returns money to.
  refunds_ref      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  trace_id         text NOT NULL
);
CREATE INDEX payment_attempts_ref_idx ON payment_attempts (merchant_id, provider_ref);
CREATE INDEX payment_attempts_refunds_idx ON payment_attempts (merchant_id, refunds_ref) WHERE kind = 'refund';
