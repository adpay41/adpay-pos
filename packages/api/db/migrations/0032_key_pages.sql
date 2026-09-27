-- Named key pages (ADR 0047): the owner's own register tabs per store, in order. Each key is an item
-- or a department with a fixed amount, validated by the API (PageKeySchema) and carried in the
-- catalog snapshot. Configuration, not ledger: a save replaces the store's pages.
CREATE TABLE key_pages (
  page_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid NOT NULL REFERENCES locations (location_id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 24),
  sort         integer NOT NULL CHECK (sort >= 0),
  keys         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keys) = 'array'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id),
  UNIQUE (location_id, sort)
);
CREATE UNIQUE INDEX key_pages_name_idx ON key_pages (location_id, lower(name));
