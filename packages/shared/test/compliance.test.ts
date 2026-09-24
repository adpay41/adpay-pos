import { describe, expect, it } from 'vitest';
import {
  ComplianceSettingsInput,
  bagFeesOn,
  chargesFor,
  computeTotals,
  effectiveMinAge,
  foldSale,
  lineCompliance,
  localDate,
  minAgesFor,
  parseRegisterEvent,
  refundQuote,
  renderReceipt,
  taxRateOn,
  type ChargeRule,
  type ComplianceSnapshot,
  type RegisterEvent,
} from '../src';

const CAT_SODA = 'c0000000-0000-4000-8000-000000000001';
const CAT_VAPE = 'c0000000-0000-4000-8000-000000000002';
const ITEM = 'a0000000-0000-4000-8000-000000000001';
const DEPOSIT = 'd0000000-0000-4000-8000-000000000001';
const VAPE_TAX = 'd0000000-0000-4000-8000-000000000002';
const BAG = 'd0000000-0000-4000-8000-000000000003';

const rules: ChargeRule[] = [
  { rule_id: DEPOSIT, kind: 'deposit', label: 'NY bottle deposit', amount_cents: 5, rate_ppm: null, category_ids: [CAT_SODA], item_ids: [], taxable: false, effective_from: '2020-01-01', effective_to: null },
  { rule_id: VAPE_TAX, kind: 'excise', label: 'NY vapor tax 20%', amount_cents: null, rate_ppm: 200_000, category_ids: [CAT_VAPE], item_ids: [], taxable: false, effective_from: '2026-10-01', effective_to: null },
  { rule_id: BAG, kind: 'bag', label: 'Paper bag fee', amount_cents: 5, rate_ppm: null, category_ids: [], item_ids: [], taxable: false, effective_from: '2020-03-01', effective_to: '2026-12-31' },
];

describe('sales-tax schedule with effective dates', () => {
  const schedule = [
    { tax_class: 'standard', rate_ppm: 88_750, effective_from: '2020-01-01' },
    { tax_class: 'standard', rate_ppm: 90_000, effective_from: '2026-10-01' },
    { tax_class: 'prepared', rate_ppm: 100_000, effective_from: '2026-01-01' },
  ];
  it('uses the latest rate that has started, by store-local date', () => {
    expect(taxRateOn(schedule, 'standard', '2026-09-30', 1)).toBe(88_750);
    expect(taxRateOn(schedule, 'standard', '2026-10-01', 1)).toBe(90_000);
  });
  it('falls back: unknown or not-yet-started class → standard; nothing → the location rate', () => {
    expect(taxRateOn(schedule, 'prepared', '2025-12-31', 1)).toBe(88_750);
    expect(taxRateOn(schedule, 'prepared', '2026-02-01', 1)).toBe(100_000);
    expect(taxRateOn([], 'standard', '2026-02-01', 66_250)).toBe(66_250);
  });
  it('store-local date: 11:30pm in New York is still the same day there', () => {
    expect(localDate('2026-10-01T03:30:00Z', 'America/New_York')).toBe('2026-09-30');
    expect(localDate('2026-10-01T04:30:00Z', 'America/New_York')).toBe('2026-10-01');
  });
});

describe('per-unit charges', () => {
  it('a fixed deposit is the same at both prices; a percentage follows each price', () => {
    expect(chargesFor({ item_id: ITEM, category_id: CAT_SODA }, { cash: 199, card: 207 }, rules, '2026-09-24')).toEqual([
      { rule_id: DEPOSIT, kind: 'deposit', label: 'NY bottle deposit', unit_cash_cents: 5, unit_card_cents: 5, taxable: false },
    ]);
    expect(chargesFor({ item_id: ITEM, category_id: CAT_VAPE }, { cash: 1_999, card: 2_079 }, rules, '2026-10-01')).toEqual([
      { rule_id: VAPE_TAX, kind: 'excise', label: 'NY vapor tax 20%', unit_cash_cents: 400, unit_card_cents: 416, taxable: false },
    ]);
  });
  it('respects effective dates, and never attaches a bag fee to an item', () => {
    expect(chargesFor({ item_id: ITEM, category_id: CAT_VAPE }, { cash: 1_999, card: 2_079 }, rules, '2026-09-30')).toEqual([]);
    expect(bagFeesOn(rules, '2026-09-24').map((r) => r.rule_id)).toEqual([BAG]);
    expect(bagFeesOn(rules, '2027-01-01')).toEqual([]);
  });
  it('a charge is paid but only a taxable charge is taxed', () => {
    const base = { qty: 6, unit_price_cents: 199, discount_cents: 0, taxable: true, tax_rate_ppm: 88_750 };
    const plain = computeTotals([base]);
    const withDeposit = computeTotals([{ ...base, charges: [{ unit_cents: 5, taxable: false }] }]);
    expect(withDeposit.subtotal_cents).toBe(plain.subtotal_cents + 30);
    expect(withDeposit.tax_cents).toBe(plain.tax_cents);
    const taxed = computeTotals([{ ...base, charges: [{ unit_cents: 5, taxable: true }] }]);
    expect(taxed.tax_cents).toBe(Math.floor(((1_194 + 30) * 88_750 + 500_000) / 1_000_000));
  });
  it('lineCompliance resolves rate and charges together; an old snapshot keeps the item rate', () => {
    const compliance: ComplianceSnapshot = { tax_rates: [{ tax_class: 'standard', rate_ppm: 88_750, effective_from: '2020-01-01' }], charges: rules, age_rules: {}, state: 'NY', min_ages: minAgesFor('NY', {}) };
    const item = { item_id: ITEM, category_id: CAT_SODA, taxable: true, tax_class: 'standard', tax_rate_ppm: 1 };
    const r = lineCompliance(item, compliance, 80_000, '2026-09-24', { cash: 199, card: 207 });
    expect(r.tax_rate_ppm).toBe(88_750);
    expect(r.charges).toHaveLength(1);
    expect(lineCompliance({ ...item, taxable: false }, compliance, 80_000, '2026-09-24', { cash: 199, card: 207 }).tax_rate_ppm).toBe(0);
    expect(lineCompliance(item, undefined, 80_000, '2026-09-24', { cash: 199, card: 207 })).toEqual({ tax_rate_ppm: 1, tax_class: 'standard', charges: [] });
  });
});

describe('age rules by state and restriction', () => {
  it('defaults by state; an override wins; the stricter of category and rule applies', () => {
    expect(minAgesFor('nj', {})).toEqual({ tobacco: 21, vape: 21, alcohol: 21, lottery: 18 });
    expect(minAgesFor(null, { lottery: 21 }).lottery).toBe(21);
    const ages = minAgesFor('NY', {});
    expect(effectiveMinAge(null, 'lottery', ages)).toBe(18);
    expect(effectiveMinAge(21, 'lottery', ages)).toBe(21);
    expect(effectiveMinAge(null, null, ages)).toBeNull();
  });
});

describe('settings validation', () => {
  it('needs exactly one of amount or percentage, and sane dates', () => {
    const r = { rule_id: DEPOSIT, kind: 'deposit', label: 'x', effective_from: '2026-01-01' };
    expect(ComplianceSettingsInput.safeParse({ charges: [{ ...r, amount_cents: 5 }] }).success).toBe(true);
    expect(ComplianceSettingsInput.safeParse({ charges: [{ ...r }] }).success).toBe(false);
    expect(ComplianceSettingsInput.safeParse({ charges: [{ ...r, amount_cents: 5, rate_ppm: 10 }] }).success).toBe(false);
    expect(ComplianceSettingsInput.safeParse({ charges: [{ ...r, amount_cents: 5, effective_to: '2025-01-01' }] }).success).toBe(false);
    expect(ComplianceSettingsInput.safeParse({ charges: [{ ...r, kind: 'bag', rate_ppm: 10 }] }).success).toBe(false);
  });
});

// A NYC sale: 6 × $1.99 water with a 5¢ deposit each, one paper bag, sales tax 8.875%.
const T = {
  org_id: '10000000-0000-4000-8000-000000000001',
  merchant_id: '20000000-0000-4000-8000-000000000001',
  location_id: '30000000-0000-4000-8000-000000000001',
  register_id: '40000000-0000-4000-8000-000000000001',
};
const SALE = '70000000-0000-4000-8000-000000000001';
const L1 = '80000000-0000-4000-8000-000000000001';
const L2 = '80000000-0000-4000-8000-000000000002';
let seq = 0;
const ev = (type: string, payload: unknown): RegisterEvent =>
  parseRegisterEvent({
    event_id: `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, schema_version: 1, sale_id: SALE, device_seq: seq,
    occurred_at: '2026-09-24T12:00:00Z', ...T, trace_id: 't', actor_user_id: null, type, payload,
  });

function nycSale() {
  seq = 0;
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', {
      line_id: L1, item_id: ITEM, name: 'Water 16oz', category_id: CAT_SODA, qty: 6, unit_cash_price_cents: 199, unit_card_price_cents: 207,
      taxable: true, tax_rate_ppm: 88_750, min_age: null, tax_class: 'standard',
      charges: [{ rule_id: DEPOSIT, kind: 'deposit', label: 'NY bottle deposit', unit_cash_cents: 5, unit_card_cents: 5, taxable: false }],
    }),
    ev('sale.line_added', {
      line_id: L2, item_id: BAG, name: 'Paper bag fee', category_id: null, qty: 1, unit_cash_price_cents: 5, unit_card_price_cents: 5,
      taxable: false, tax_rate_ppm: 0, min_age: null, price_source: 'fee',
    }),
  ];
  const s0 = foldSale(SALE, events);
  events.push(
    ev('sale.tender_added', { tender_id: '90000000-0000-4000-8000-0000000000aa', tender_type: 'cash', amount_cents: s0.cash.total_cents, tendered_cents: 2_000, change_cents: 2_000 - s0.cash.total_cents, card: null }),
    ev('sale.completed', { price_mode: 'cash', ...s0.cash }),
  );
  return events;
}

describe('a sale with a deposit and a bag fee', () => {
  it('folds: subtotal includes deposits and the bag, tax only on the water', () => {
    const s = foldSale(SALE, nycSale());
    // water 1194 + deposit 30 + bag 5 = 1229; tax 8.875% of 1194 = 105.97 → 106
    expect(s.cash).toEqual({ subtotal_cents: 1_229, tax_cents: 106, total_cents: 1_335 });
    // deposits and fees are not marked up at the card price
    expect(s.card.subtotal_cents - s.cash.subtotal_cents).toBe(6 * 8);
    expect(s.mismatch).toBe(false);
    expect(s.lines.find((l) => l.line_id === L2)?.is_fee).toBe(true);
  });

  it('prints the deposit under the item and the lines add up to the total', () => {
    const s = foldSale(SALE, nycSale());
    const text = renderReceipt({
      header: { merchant_name: 'Bodega', location_name: 'Main', address_line1: null, city_state_zip: null, register_name: 'R1' },
      sale: s, occurred_at: '2026-09-24T12:00:00Z', timezone: 'America/New_York', copy: 'original',
    }).map((l) => l.text);
    expect(text.some((l) => /NY bottle deposit 6 x \$0\.05\s+\$0\.30/.test(l))).toBe(true);
    expect(text.some((l) => /Paper bag fee N\s+\$0\.05/.test(l))).toBe(true);
    expect(text.some((l) => /Tax 8\.875% on \$11\.94\s+\$1\.06/.test(l))).toBe(true);
    expect(text.some((l) => /TOTAL\s+\$13\.35/.test(l))).toBe(true);
  });

  it('a returned bottle gives the deposit back with it', () => {
    const s = foldSale(SALE, nycSale());
    // 199 + 5 deposit + tax on 199 (17.66 → 18) = 222
    expect(refundQuote(s, [{ line_id: L1, qty: 1 }]).amount_cents).toBe(222);
  });
});
