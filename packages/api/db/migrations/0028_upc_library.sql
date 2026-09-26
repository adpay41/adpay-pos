-- Phase 25c: the global UPC library (Bible 3.4; ADR 0041). Read across every store's catalog on the
-- barcode key — the same rule as `barcodeKey` in @adpay/shared: digits without leading zeros, other
-- codes upper-cased — so UPC-A, EAN-13 and GTIN-14 spellings of one product meet.
CREATE FUNCTION barcode_key(code text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN btrim(code) ~ '^[0-9]+$' THEN coalesce(nullif(ltrim(btrim(code), '0'), ''), '0') ELSE upper(btrim(code)) END
$$;

CREATE INDEX item_barcodes_key_idx ON item_barcodes (barcode_key(barcode));
CREATE INDEX items_upc_key_idx ON items (barcode_key(upc)) WHERE upc IS NOT NULL;
