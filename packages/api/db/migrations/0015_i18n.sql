-- Phase 18: languages and the digital receipt (Bible 1.5, 1.6, 3.4; ADR 0027).
-- Platform-wide configuration, edited by AD Pay admins in Translations and delivered to registers in
-- the config snapshot. Mutable and audited; not ledger. Rows exist only where an admin changed the
-- code default (i18n.ts LANGUAGE_DEFAULT_STATUS, i18n-messages.ts).
CREATE TABLE language_settings (
  lang         text PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('draft', 'available', 'reviewed')),
  reviewed_by  uuid REFERENCES users (user_id),
  reviewed_at  timestamptz,
  review_note  text CHECK (length(review_note) <= 300),
  updated_by   uuid REFERENCES users (user_id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE translation_overrides (
  lang        text NOT NULL,
  key         text NOT NULL,
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  updated_by  uuid REFERENCES users (user_id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lang, key)
);

-- The digital receipt page looks a sale up by the random token captured on sale.completed.
CREATE INDEX sale_events_receipt_token_idx ON sale_events ((payload->>'receipt_token')) WHERE type = 'sale.completed';
