-- Phase 11: per-merchant alert settings (Bible 2.6 L37/L38): muted merchant-facing rules and the
-- thresholds behind the money alerts. Validated by AlertSettingsInput in packages/shared; '{}' = defaults.
ALTER TABLE merchants ADD COLUMN alert_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
