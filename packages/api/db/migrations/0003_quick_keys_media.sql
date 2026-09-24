-- Phase 2: catalog from the phone (build plan F1, part 2).
--
-- Product photos, per-item tile color and order, and per-location favorites (the register's first
-- quick-key page).

-- Uploaded product photos. Stored in Postgres for v1 (small: clients resize to ~512px JPEG, the API
-- caps at 1 MB), behind the MediaStore interface so S3 can replace it without touching callers
-- (ADR 0010). Content-addressed per merchant: re-uploading the same photo returns the same row.
-- Immutable: a new photo is a new row.
CREATE TABLE media (
  media_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  sha256        text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size     integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 1000000),
  bytes         bytea NOT NULL,
  created_by    uuid REFERENCES users (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  trace_id      text NOT NULL,
  UNIQUE (merchant_id, sha256),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE TRIGGER media_immutable
  BEFORE UPDATE OR DELETE ON media
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE items
  ADD COLUMN image_id  uuid REFERENCES media (media_id),
  -- A key from TILE_COLORS in packages/shared (never red: tiles sit next to prices).
  ADD COLUMN color     text CHECK (color IS NULL OR color IN ('blue', 'teal', 'purple', 'orange', 'yellow', 'brown', 'gray', 'navy')),
  ADD COLUMN sort      integer NOT NULL DEFAULT 0 CHECK (sort >= 0);

-- Per-location favorites, in tile order. Replaced as a whole list on each save.
CREATE TABLE location_quick_keys (
  org_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  item_id      uuid NOT NULL REFERENCES items (item_id),
  position     integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (location_id, item_id),
  UNIQUE (location_id, position),
  FOREIGN KEY (org_id, merchant_id, location_id) REFERENCES locations (org_id, merchant_id, location_id)
);

-- The snapshot shape changed (quick_keys, color, image_url, sort): move every merchant's version
-- so registers pull a fresh snapshot on their next tick instead of running on a cached old one.
UPDATE merchants SET catalog_version = catalog_version + 1;
