-- Phase 10: tax & compliance tables, basic (F7, ADR 0018).
--
-- Categories carry a sales-tax class and a restriction kind (the state's age rule for it applies).
-- Each location carries its rule set as validated JSON (ComplianceSettingsInput in packages/shared):
-- a dated sales-tax schedule per class, per-unit charges (deposit, excise, fee, bag) with dates,
-- and age overrides. '{}' means none: the location's plain tax_rate_ppm and the state age defaults.
-- The register captures what applied into each sale line event, so history never re-prices.
ALTER TABLE categories
  ADD COLUMN tax_class   text NOT NULL DEFAULT 'standard' CHECK (tax_class ~ '^[a-z][a-z0-9_]{1,23}$'),
  ADD COLUMN restriction text CHECK (restriction IN ('tobacco', 'vape', 'alcohol', 'lottery'));

ALTER TABLE locations ADD COLUMN compliance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The snapshot gained a compliance section: move every merchant's version once.
UPDATE merchants SET catalog_version = catalog_version + 1;
