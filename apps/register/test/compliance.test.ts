/**
 * P10 on the register: the tax rate and per-unit charges resolve at ring time by the store-local
 * date and are captured in the line event; a bag fee rings as its own line; everything still works
 * offline, and an older snapshot without compliance behaves as before.
 */
import { randomUUID } from 'node:crypto';
import { cents, feeItem, minAgesFor, renderReceipt, type CatalogItem, type ChargeRule, type ComplianceSnapshot } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const DRINKS = randomUUID();

const WATER: CatalogItem = {
  item_id: randomUUID(), category_id: DRINKS, name: 'Water 16oz', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 199,
  card_price_cents: 207, card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 88_750, tax_class: 'standard',
  min_age: null, restriction: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};
const deposit: ChargeRule = { rule_id: randomUUID(), kind: 'deposit', label: 'NY bottle deposit', amount_cents: 5, rate_ppm: null, category_ids: [DRINKS], item_ids: [], taxable: false, effective_from: '2020-01-01', effective_to: null };
const bag: ChargeRule = { rule_id: randomUUID(), kind: 'bag', label: 'Paper bag fee', amount_cents: 5, rate_ppm: null, category_ids: [], item_ids: [], taxable: false, effective_from: '2020-01-01', effective_to: null };
const compliance: ComplianceSnapshot = {
  tax_rates: [
    { tax_class: 'standard', rate_ppm: 88_750, effective_from: '2020-01-01' },
    { tax_class: 'standard', rate_ppm: 90_000, effective_from: '2026-10-01' },
  ],
  charges: [deposit, bag],
  age_rules: {},
  state: 'NY',
  min_ages: minAgesFor('NY', {}),
};

function session(now: string, snap: ComplianceSnapshot | null = compliance) {
  return new SaleSession({
    store: new MemoryEventStore(),
    tenancy,
    catalogVersion: () => 7,
    uuid: randomUUID,
    now: () => new Date(now),
    compliance: () => ({ snapshot: snap ?? undefined, locationRatePpm: 88_750, timezone: 'America/New_York' }),
  });
}

describe('compliance at ring time', () => {
  it('captures the deposit and the rate in force today; totals include the deposit, tax does not', async () => {
    const s = session('2026-09-24T16:00:00Z');
    await s.addItem(WATER, { qty: 6 });
    const sale = s.state().sale!;
    expect(sale.lines[0]!.charges).toEqual([{ rule_id: deposit.rule_id, kind: 'deposit', label: 'NY bottle deposit', unit_cash_cents: 5, unit_card_cents: 5, taxable: false }]);
    expect(sale.lines[0]!.tax_rate_ppm).toBe(88_750);
    // 1194 + 30 deposit; tax 8.875% of 1194 → 106
    expect(sale.cash).toEqual({ subtotal_cents: 1_224, tax_cents: 106, total_cents: 1_330 });
  });

  it('a new rate takes effect on its day by the store clock, even with no server', async () => {
    // 11:30pm Sep 30 in New York is still September there.
    const before = session('2026-10-01T03:30:00Z');
    await before.addItem(WATER);
    expect(before.state().sale!.lines[0]!.tax_rate_ppm).toBe(88_750);
    const after = session('2026-10-01T04:30:00Z');
    await after.addItem(WATER);
    expect(after.state().sale!.lines[0]!.tax_rate_ppm).toBe(90_000);
  });

  it('a bag fee rings as its own line, merges on a second tap, and completes a cash sale', async () => {
    const s = session('2026-09-24T16:00:00Z');
    await s.addItem(WATER);
    await s.addItem(feeItem(bag, 88_750), { fee: true });
    await s.addItem(feeItem(bag, 88_750), { fee: true });
    const sale = s.state().sale!;
    const fee = sale.lines.find((l) => l.is_fee)!;
    expect(fee).toMatchObject({ name: 'Paper bag fee', qty: 2, taxable: false });
    // water 199 + 5 deposit + 2 bags 10 = 214; tax on 199 = 17.66 → 18
    expect(sale.cash.total_cents).toBe(232);
    // only the water is marked up: 207 vs 199; its tax rounds to 18 either way
    expect(sale.card.total_cents - sale.cash.total_cents).toBe(8);
    const { sale: done } = await s.tenderCash(cents(500));
    expect(done.status).toBe('completed');
    const receipt = renderReceipt({
      header: { merchant_name: 'Bodega', location_name: 'Main', address_line1: null, city_state_zip: null, register_name: 'R1' },
      sale: done, occurred_at: '2026-09-24T16:00:00Z', timezone: 'America/New_York', copy: 'original',
    }).map((l) => l.text);
    expect(receipt.some((l) => l.includes('NY bottle deposit'))).toBe(true);
    expect(receipt.some((l) => l.startsWith('2 x Paper bag fee'))).toBe(true);
  });

  it('an older snapshot without compliance keeps the item rate and adds no charges', async () => {
    const s = session('2026-10-02T16:00:00Z', null);
    await s.addItem({ ...WATER, tax_rate_ppm: 66_250 });
    expect(s.state().sale!.lines[0]).toMatchObject({ tax_rate_ppm: 66_250, charges: [] });
  });
});
