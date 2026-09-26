/**
 * Promotions on the register (P20a): the session reprices after every line change, writing only what
 * changed as line discounts with the promotion's id; a broken pair is reset; a manual discount wins.
 */
import { randomUUID } from 'node:crypto';
import { PromotionInput, type CatalogItem, type Promotion } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const DRINKS = randomUUID();
const can = (name: string, cash: number): CatalogItem => ({
  item_id: randomUUID(), category_id: DRINKS, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: Math.round(cash * 1.04),
  card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0, min_age: null, sell_unit: 'each', pack_qty: 1, active: true,
  color: null, image_url: null, sort: 0,
});
const RED_BULL = can('Red Bull', 299);
const MONSTER = can('Monster', 329);
const twoFor5: Promotion = { promo_id: randomUUID(), active: true, ...PromotionInput.parse({ name: '2 for $5', rule: { kind: 'multi_price', qty: 2, price_cents: 500 }, category_ids: [DRINKS], starts_on: '2026-01-01' }) };

async function setup(promotions: Promotion[]) {
  const store = new MemoryEventStore();
  const session = new SaleSession({
    store, tenancy, catalogVersion: () => 1, uuid: randomUUID, now: () => new Date('2026-09-25T16:00:00Z'),
    promotions: () => ({ promotions, location_id: tenancy.location_id, timezone: 'America/New_York', dual_price_rate_ppm: 40_000 }),
  });
  await session.restore();
  return { store, session };
}

describe('promotions at the register', () => {
  it('the second can completes the deal; removing it undoes the deal', async () => {
    const { session, store } = await setup([twoFor5]);
    await session.addItem(RED_BULL);
    expect(session.state().sale!.cash.subtotal_cents).toBe(299);
    await session.addItem(MONSTER);
    const sale = session.state().sale!;
    expect(sale.cash.subtotal_cents).toBe(500);
    expect(sale.lines.every((l) => l.discount_promo_id === twoFor5.promo_id && l.discount_reason === 'Promo: 2 for $5')).toBe(true);
    await session.removeLine(sale.lines[1]!.line_id);
    expect(session.state().sale!.cash.subtotal_cents).toBe(299);
    expect(session.state().sale!.lines[0]!.discount_promo_id).toBeNull();
    const discounts = (await store.unacked(100)).filter((e) => e.type === 'sale.line_discounted');
    expect(discounts).toHaveLength(3); // two when the pair formed, one reset when it broke
  });

  it('ringing the same can again merges the line and still prices the pair', async () => {
    const { session } = await setup([twoFor5]);
    await session.addItem(RED_BULL);
    await session.addItem(RED_BULL);
    expect(session.state().sale!.lines).toHaveLength(1);
    expect(session.state().sale!.cash.subtotal_cents).toBe(500);
  });

  it('no promotions, no discount events', async () => {
    const { session, store } = await setup([]);
    await session.addItem(RED_BULL);
    await session.addItem(MONSTER);
    expect((await store.unacked(100)).some((e) => e.type === 'sale.line_discounted')).toBe(false);
  });
});
