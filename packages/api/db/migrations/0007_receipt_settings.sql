-- Phase 8: per-location receipt settings (logo, header lines, return policy, QR, after-sale
-- behaviour). Validated by ReceiptSettingsInput in packages/shared; '{}' means the defaults.
ALTER TABLE locations ADD COLUMN receipt_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The snapshot gained a receipt section: move every merchant's version once.
UPDATE merchants SET catalog_version = catalog_version + 1;
