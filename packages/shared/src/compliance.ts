/**
 * Tax & compliance tables, basic (build plan P10 / F7, Bible 1.4 L16 + L17). ADR 0018.
 *
 * Per location, one rule set travels in the register's snapshot:
 *   - a **sales-tax schedule**: rate per tax class with an effective date, so a rate change set in
 *     advance takes effect on the right day, even on a register that is offline that day;
 *   - **per-unit charges**: excise (vape, cigarettes where not stamped into the price), container
 *     deposits (NY 5¢), fees (sugar), and a **bag fee** rung from its own key. Each is a fixed
 *     amount per unit or a percentage of the unit price, with effective dates;
 *   - **age rules** by restriction kind (tobacco / vape / alcohol / lottery), defaulting by state.
 *
 * The register resolves rate and charges **at the moment of sale** and writes them into the line
 * event, like prices, so a receipt reprinted years later is exact (ADR 0002).
 *
 * The values in `STATE_TEMPLATES` are drafts to start from. **They need an accountant's sign-off
 * before a store relies on them** (build plan section 4). Nothing applies a template by itself.
 */
import { z } from 'zod';
import type { CatalogItem } from './api';
import { applyRateHalfUp, cents, type Cents } from './money';

export const RESTRICTIONS = ['tobacco', 'vape', 'alcohol', 'lottery'] as const;
export type Restriction = (typeof RESTRICTIONS)[number];
export const RestrictionInput = z.enum(RESTRICTIONS);

export const RESTRICTION_LABELS: Record<Restriction, string> = {
  tobacco: 'Tobacco',
  vape: 'Vape / e-cig',
  alcohol: 'Alcohol',
  lottery: 'Lottery',
};

/** A tax class is a short slug; `standard` is the location's ordinary sales-tax rate. */
export const STANDARD_TAX_CLASS = 'standard';
export const TaxClassInput = z.string().trim().regex(/^[a-z][a-z0-9_]{1,23}$/, 'Tax class: 2–24 lowercase letters, digits or _');

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');
const Ppm = z.int().min(0).max(1_000_000);

export const TaxRateEntryInput = z.strictObject({
  tax_class: TaxClassInput,
  rate_ppm: Ppm.max(300_000, 'A sales-tax rate above 30% is not allowed'),
  effective_from: IsoDate,
});
export type TaxRateEntry = z.infer<typeof TaxRateEntryInput>;

export const CHARGE_KINDS = ['excise', 'deposit', 'fee', 'bag'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const ChargeRuleInput = z
  .strictObject({
    /** Minted by the editor. A bag fee is rung as its own line, and this is that line's item id. */
    rule_id: z.uuid(),
    kind: z.enum(CHARGE_KINDS),
    /** Printed on the receipt under the item ("NY bottle deposit"). */
    label: z.string().trim().min(1).max(32),
    /** Exactly one of: a fixed amount per unit, or a share of the unit price. */
    amount_cents: z.int().min(1).max(100_000).nullable().default(null),
    rate_ppm: Ppm.min(1).nullable().default(null),
    /** What it applies to. Empty = nothing yet (a template fills the kind; the store picks categories). */
    category_ids: z.array(z.uuid()).max(100).default([]),
    item_ids: z.array(z.uuid()).max(500).default([]),
    /** Whether the charge is part of the item's sales-tax base (only matters for a taxed item). */
    taxable: z.boolean().default(false),
    effective_from: IsoDate,
    effective_to: IsoDate.nullable().default(null),
  })
  .refine((r) => (r.amount_cents === null) !== (r.rate_ppm === null), { message: 'Give either an amount per unit or a percentage', path: ['amount_cents'] })
  .refine((r) => r.kind !== 'bag' || r.amount_cents !== null, { message: 'A bag fee is a fixed amount', path: ['amount_cents'] })
  .refine((r) => r.effective_to === null || r.effective_to >= r.effective_from, { message: 'Ends before it starts', path: ['effective_to'] });
export type ChargeRule = z.infer<typeof ChargeRuleInput>;

export const ComplianceSettingsInput = z
  .strictObject({
    tax_rates: z.array(TaxRateEntryInput).max(60).default([]),
    charges: z.array(ChargeRuleInput).max(100).default([]),
    /** Minimum age per restriction; a missing kind uses the state default. */
    age_rules: z.partialRecord(RestrictionInput, z.int().min(0).max(99)).default({}),
  })
  .refine((s) => new Set(s.charges.map((c) => c.rule_id)).size === s.charges.length, { message: 'Duplicate charge rule', path: ['charges'] })
  .refine((s) => new Set(s.tax_rates.map((t) => `${t.tax_class}@${t.effective_from}`)).size === s.tax_rates.length, {
    message: 'Two rates for the same class on the same date',
    path: ['tax_rates'],
  });
export type ComplianceSettings = z.infer<typeof ComplianceSettingsInput>;

export const DEFAULT_COMPLIANCE: ComplianceSettings = { tax_rates: [], charges: [], age_rules: {} };

/** What a register gets: the location's rule set plus its state (for age defaults), resolved. */
export interface ComplianceSnapshot extends ComplianceSettings {
  state: string | null;
  /** Effective minimum age per restriction at this location (state default ⊕ overrides). */
  min_ages: Record<Restriction, number>;
}

// ───────────────────────────────────────────────────────────────────────── age ──

/** Federal Tobacco 21 covers tobacco and vapor products; alcohol is 21 everywhere in the US. */
const FEDERAL_MIN_AGE: Record<Restriction, number> = { tobacco: 21, vape: 21, alcohol: 21, lottery: 18 };

/** State defaults (NJ and NY sell lottery at 18). Drafts: confirm with counsel per state. */
export const STATE_MIN_AGE: Record<string, Partial<Record<Restriction, number>>> = {
  NJ: { tobacco: 21, vape: 21, alcohol: 21, lottery: 18 },
  NY: { tobacco: 21, vape: 21, alcohol: 21, lottery: 18 },
};

export function minAgesFor(state: string | null, overrides: ComplianceSettings['age_rules']): Record<Restriction, number> {
  const st = state ? STATE_MIN_AGE[state.toUpperCase()] : undefined;
  const out = {} as Record<Restriction, number>;
  for (const r of RESTRICTIONS) {
    const o = overrides[r];
    out[r] = o !== undefined && o > 0 ? o : (st?.[r] ?? FEDERAL_MIN_AGE[r]);
  }
  return out;
}

/** The age check an item needs: the stricter of its category's own setting and its restriction's rule. */
export function effectiveMinAge(categoryMinAge: number | null, restriction: Restriction | null, minAges: Record<Restriction, number> | null): number | null {
  const byRule = restriction && minAges ? minAges[restriction] : 0;
  const age = Math.max(categoryMinAge ?? 0, byRule);
  return age > 0 ? age : null;
}

// ───────────────────────────────────────────────────────────────────────── dates ──

/** The store-local calendar date (YYYY-MM-DD) of an instant: the day a rate or rule is judged by. */
export function localDate(at: Date | string, timezone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// ───────────────────────────────────────────────────────────────────────── tax ──

/**
 * The rate for a tax class on a date: the latest entry that has started. A class with no entry in
 * force falls back to `standard`, and `standard` with none falls back to the location's plain rate.
 */
export function taxRateOn(schedule: readonly TaxRateEntry[], taxClass: string | null, date: string, fallbackPpm: number): number {
  const pick = (cls: string) =>
    schedule
      .filter((e) => e.tax_class === cls && e.effective_from <= date)
      .reduce<TaxRateEntry | null>((best, e) => (!best || e.effective_from > best.effective_from ? e : best), null);
  const hit = pick(taxClass ?? STANDARD_TAX_CLASS) ?? pick(STANDARD_TAX_CLASS);
  return hit ? hit.rate_ppm : fallbackPpm;
}

// ───────────────────────────────────────────────────────────────────────── charges ──

/** A charge as captured on a sale line: per unit, in each price mode. */
export interface LineCharge {
  rule_id: string;
  kind: ChargeKind;
  label: string;
  unit_cash_cents: number;
  unit_card_cents: number;
  taxable: boolean;
}

export function chargeActive(rule: ChargeRule, date: string): boolean {
  return rule.effective_from <= date && (rule.effective_to === null || date <= rule.effective_to);
}

/**
 * Per-unit charges on an item on a date. A fixed amount is the same at both prices (a deposit is
 * not a card surcharge); a percentage applies to each price, rounded half-up once per unit.
 */
export function chargesFor(
  target: { item_id: string; category_id: string | null },
  unit: { cash: number; card: number },
  rules: readonly ChargeRule[],
  date: string,
): LineCharge[] {
  return rules
    .filter((r) => r.kind !== 'bag' && chargeActive(r, date))
    .filter((r) => r.item_ids.includes(target.item_id) || (target.category_id !== null && r.category_ids.includes(target.category_id)))
    .map((r) => {
      const at = (price: number): number => (r.amount_cents !== null ? r.amount_cents : applyRateHalfUp(cents(price), r.rate_ppm!));
      return { rule_id: r.rule_id, kind: r.kind, label: r.label, unit_cash_cents: at(unit.cash), unit_card_cents: at(unit.card), taxable: r.taxable };
    });
}

/** Bag fees in force on a date: the register shows one key per rule. */
export function bagFeesOn(rules: readonly ChargeRule[], date: string): ChargeRule[] {
  return rules.filter((r) => r.kind === 'bag' && chargeActive(r, date));
}

/**
 * A bag fee as something the register can ring: its own line, same price cash or card (a fee is
 * not marked up), the rule id as the item id. Taxed at the standard rate only if the rule says so.
 */
export function feeItem(rule: ChargeRule, standardRatePpm: number): CatalogItem {
  const price = rule.amount_cents ?? 0;
  return {
    item_id: rule.rule_id,
    category_id: null,
    name: rule.label,
    sku: null,
    upc: null,
    plu: null,
    barcodes: [],
    cash_price_cents: price,
    card_price_cents: price,
    card_price_override: true,
    open_price: false,
    cost_cents: null,
    taxable: rule.taxable,
    tax_rate_ppm: rule.taxable ? standardRatePpm : 0,
    tax_class: STANDARD_TAX_CLASS,
    min_age: null,
    restriction: null,
    color: null,
    image_url: null,
    sort: 0,
    sell_unit: 'each',
    pack_qty: 1,
    active: true,
  };
}

/** Total of a line's charges per unit in one price mode. */
export function unitCharges(charges: readonly Pick<LineCharge, 'unit_cash_cents' | 'unit_card_cents'>[], mode: 'cash' | 'card'): Cents {
  return cents(charges.reduce((n, c) => n + (mode === 'card' ? c.unit_card_cents : c.unit_cash_cents), 0));
}

/**
 * What a line captures at the moment it is rung: the tax rate in force for its class today, and its
 * per-unit charges at the unit prices it is sold at. Without a compliance section (an older cached
 * snapshot) the item's snapshot rate stands and there are no charges.
 */
export function lineCompliance(
  item: { item_id: string; category_id: string | null; taxable: boolean; tax_class?: string | null; tax_rate_ppm: number },
  compliance: ComplianceSnapshot | undefined,
  locationRatePpm: number,
  date: string,
  unit: { cash: number; card: number },
): { tax_rate_ppm: number; tax_class: string | null; charges: LineCharge[] } {
  if (!compliance) return { tax_rate_ppm: item.tax_rate_ppm, tax_class: item.tax_class ?? null, charges: [] };
  const taxClass = item.tax_class ?? STANDARD_TAX_CLASS;
  return {
    tax_rate_ppm: item.taxable ? taxRateOn(compliance.tax_rates, taxClass, date, locationRatePpm) : 0,
    tax_class: taxClass,
    charges: chargesFor(item, unit, compliance.charges, date),
  };
}

// ───────────────────────────────────────────────────────────────────────── templates ──

export interface ComplianceTemplate {
  state: string;
  title: string;
  /** Plain-language notes shown with the template, including what it deliberately leaves out. */
  notes: string[];
  tax_rates: Omit<TaxRateEntry, never>[];
  /** Charges without ids or targets: the editor mints the id and the store picks categories. */
  charges: Omit<ChargeRule, 'rule_id' | 'category_ids' | 'item_ids'>[];
}

/**
 * Starting points, not law. **Every value needs an accountant's sign-off** before a store relies
 * on it. Cigarette excise is left out: in NJ and NY it is paid through tax stamps and is already
 * in the shelf price, so charging it again at the register would double it.
 */
export const STATE_TEMPLATES: Record<'NJ' | 'NY' | 'NYC', ComplianceTemplate> = {
  NJ: {
    state: 'NJ',
    title: 'New Jersey (draft)',
    notes: ['Sales tax 6.625%.', 'No container deposit.', 'Single-use bags are banned; no bag fee.', 'Cigarette excise is in the stamped price.'],
    tax_rates: [{ tax_class: STANDARD_TAX_CLASS, rate_ppm: 66_250, effective_from: '2018-01-01' }],
    charges: [],
  },
  NY: {
    state: 'NY',
    title: 'New York State outside NYC (draft — add the county rate)',
    notes: ['State sales tax 4% plus the county rate: set the combined rate.', 'Bottle deposit 5¢ per container.', 'Vapor products: 20% supplemental tax.'],
    tax_rates: [{ tax_class: STANDARD_TAX_CLASS, rate_ppm: 80_000, effective_from: '2020-01-01' }],
    charges: [
      { kind: 'deposit', label: 'NY bottle deposit', amount_cents: 5, rate_ppm: null, taxable: false, effective_from: '2020-01-01', effective_to: null },
      { kind: 'excise', label: 'NY vapor tax 20%', amount_cents: null, rate_ppm: 200_000, taxable: false, effective_from: '2020-01-01', effective_to: null },
    ],
  },
  NYC: {
    state: 'NY',
    title: 'New York City (draft)',
    notes: ['Sales tax 8.875%.', 'Bottle deposit 5¢ per container.', 'Paper bag fee 5¢.', 'Vapor products: 20% supplemental tax.'],
    tax_rates: [{ tax_class: STANDARD_TAX_CLASS, rate_ppm: 88_750, effective_from: '2020-01-01' }],
    charges: [
      { kind: 'deposit', label: 'NY bottle deposit', amount_cents: 5, rate_ppm: null, taxable: false, effective_from: '2020-01-01', effective_to: null },
      { kind: 'bag', label: 'Paper bag fee', amount_cents: 5, rate_ppm: null, taxable: false, effective_from: '2020-03-01', effective_to: null },
      { kind: 'excise', label: 'NY vapor tax 20%', amount_cents: null, rate_ppm: 200_000, taxable: false, effective_from: '2020-01-01', effective_to: null },
    ],
  },
};
