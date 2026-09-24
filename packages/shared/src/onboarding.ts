/**
 * Onboarding and merchant commercial terms (build plan P12, Bible 3.1 L42/L43 and 3.3 L51). ADR 0020.
 *
 * Rates are integer ppm (1% = 10_000), money is integer cents, dates are store-local YYYY-MM-DD.
 */
import { z } from 'zod';
import { PACK_IDS } from './packs';

const Ppm = z.int().min(0).max(1_000_000);
const Cents = z.int().min(0).max(10_000_000);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');

/**
 * What AD Pay charges a merchant. One of three processing models, plus the POS subscription.
 * Plans are append-only with an effective date, so the history is the rows themselves (L51).
 */
export const PricingPlanInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dual_pricing'),
    /** The card price markup customers see; the processing cost is covered by it. */
    dual_price_rate_ppm: Ppm.max(100_000, 'Card price markup above 10% is not allowed'),
    monthly_cents: Cents,
    per_register_cents: Cents.default(0),
    effective_from: IsoDate,
    note: z.string().trim().max(200).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('ic_plus'),
    /** Interchange plus this percentage and this per-transaction fee. */
    markup_ppm: Ppm.max(50_000),
    per_txn_cents: Cents.max(100),
    monthly_cents: Cents,
    per_register_cents: Cents.default(0),
    effective_from: IsoDate,
    note: z.string().trim().max(200).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('flat'),
    rate_ppm: Ppm.max(60_000),
    per_txn_cents: Cents.max(100),
    monthly_cents: Cents,
    per_register_cents: Cents.default(0),
    effective_from: IsoDate,
    note: z.string().trim().max(200).nullable().default(null),
  }),
]);
export type PricingPlan = z.infer<typeof PricingPlanInput>;

export const PLAN_KIND_LABELS: Record<PricingPlan['kind'], string> = {
  dual_pricing: 'Dual pricing (cash discount)',
  ic_plus: 'Interchange plus',
  flat: 'Flat rate',
};

export interface PricingPlanRow {
  plan_id: string;
  plan: PricingPlan;
  created_at: string;
  created_by_name: string | null;
  /** The plan in force today (latest effective date that has started). */
  current: boolean;
}

/** The plan in force on `date`: the latest effective_from ≤ date; ties go to the newest row. */
export function planOn<T extends { plan: PricingPlan; created_at: string }>(rows: readonly T[], date: string): T | null {
  return rows
    .filter((r) => r.plan.effective_from <= date)
    .reduce<T | null>((best, r) => (!best || r.plan.effective_from > best.plan.effective_from || (r.plan.effective_from === best.plan.effective_from && r.created_at > best.created_at) ? r : best), null);
}

/** Onboarding progress; KYB runs through the processor and waits for the AD Pay LLC account (⛔). */
export const ONBOARDING_STATUSES = ['setting_up', 'ready_to_install', 'live'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export const KYB_STATUSES = ['not_started', 'submitted', 'approved', 'declined'] as const;

const Phone = z.string().trim().regex(/^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/, 'A 10-digit US phone number');

/** Everything the wizard collects; the API applies it in one transaction. */
export const OnboardingInput = z.strictObject({
  org: z.union([z.strictObject({ org_id: z.uuid() }), z.strictObject({ name: z.string().trim().min(1).max(200) })]),
  merchant: z.strictObject({
    name: z.string().trim().min(1).max(200),
    legal_name: z.string().trim().max(200).nullable().default(null),
    enabled_packs: z.array(z.enum(PACK_IDS)).min(1).default(['cstore']),
  }),
  owner: z.strictObject({ name: z.string().trim().min(1).max(80), phone: Phone }),
  location: z.strictObject({
    name: z.string().trim().min(1).max(200),
    address_line1: z.string().trim().max(200).nullable().default(null),
    city: z.string().trim().max(100).nullable().default(null),
    state: z.string().trim().length(2).toUpperCase(),
    postal_code: z.string().trim().max(10).nullable().default(null),
    timezone: z.string().default('America/New_York'),
    tax_rate_ppm: Ppm.max(300_000),
    /** A starting rule set from `STATE_TEMPLATES` (drafts: accountant sign-off). */
    compliance_template: z.enum(['NJ', 'NY', 'NYC']).nullable().default(null),
  }),
  registers: z.int().min(1).max(10).default(1),
  pricing: PricingPlanInput,
  install_date: IsoDate.nullable().default(null),
  hardware_note: z.string().trim().max(500).nullable().default(null),
});
export type Onboarding = z.infer<typeof OnboardingInput>;

export interface OnboardingResult {
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_ids: string[];
  owner_user_id: string;
}

export interface OnboardingRow {
  merchant_id: string;
  merchant_name: string;
  org_name: string;
  status: OnboardingStatus;
  kyb_status: (typeof KYB_STATUSES)[number];
  install_date: string | null;
  hardware_note: string | null;
  registers: number;
  registers_paired: number;
  created_at: string;
}

/** Install kits are printed ahead of the visit, so their codes last longer than a one-off code. */
export const INSTALL_KIT_CODE_TTL_HOURS = 14 * 24;
