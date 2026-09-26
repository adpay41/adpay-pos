import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { foldSale, foldStock, isDeadStock, ItemStockSettingsInput, parseRegisterEvent, type Movement } from '../src';

const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const PACK = randomUUID();
const CARTON = randomUUID();
const MILK = randomUUID();
const items = [
  { item_id: PACK, stock_of: null, stock_ratio: 1 },
  { item_id: CARTON, stock_of: PACK, stock_ratio: 10 },
  { item_id: MILK, stock_of: null, stock_ratio: 1 },
];

function sale(at: string, lines: { item: string; qty: number; refund?: number }[], voided = false) {
  const id = randomUUID();
  let seq = 0;
  const events = [] as ReturnType<typeof parseRegisterEvent>[];
  const ev = (type: string, payload: unknown) => events.push(parseRegisterEvent({ event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: at, ...t, trace_id: 'x', type, payload }));
  ev('sale.opened', { cashier_user_id: null, catalog_version: 1 });
  const ids = lines.map((l) => {
    const line_id = randomUUID();
    ev('sale.line_added', { line_id, item_id: l.item, name: 'x', category_id: null, qty: l.qty, unit_cash_price_cents: 100, unit_card_price_cents: 100, taxable: false, tax_rate_ppm: 0, min_age: null });
    return line_id;
  });
  const total = lines.reduce((n, l) => n + l.qty * 100, 0);
  ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: total, tendered_cents: total, change_cents: 0, card: null });
  ev('sale.completed', { price_mode: 'cash', subtotal_cents: total, tax_cents: 0, total_cents: total });
  lines.forEach((l, i) => l.refund && ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: l.refund * 100, reason: 'Returned', by_user_id: null, card: null, lines: [{ line_id: ids[i]!, qty: l.refund }] }));
  if (voided) {
    ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: total, reason: 'Void', by_user_id: null, card: null, lines: [] });
    ev('sale.voided', { reason: 'x', by_user_id: null });
  }
  return { ...foldSale(id, events), occurred_at: at };
}

describe('stock', () => {
  it('a count sets the level; receipts add; sales and write-offs take away; cartons count as 10 packs', () => {
    const moves: Movement[] = [
      { item_id: PACK, kind: 'receive', qty: 5, at: '2026-09-01T10:00:00Z' }, // before the count: ignored by it
      { item_id: PACK, kind: 'count', qty: 40, at: '2026-09-02T09:00:00Z' },
      { item_id: CARTON, kind: 'receive', qty: 3, at: '2026-09-03T09:00:00Z' }, // +30 packs
      { item_id: PACK, kind: 'adjust', qty: -2, at: '2026-09-03T12:00:00Z' }, // damaged
    ];
    const sales = [
      sale('2026-09-01T12:00:00Z', [{ item: PACK, qty: 4 }]), // before the count
      sale('2026-09-03T15:00:00Z', [{ item: PACK, qty: 5 }, { item: CARTON, qty: 1 }]), // −15
      sale('2026-09-04T15:00:00Z', [{ item: PACK, qty: 3, refund: 1 }]), // −2
      sale('2026-09-04T16:00:00Z', [{ item: PACK, qty: 6 }], true), // voided: nothing
    ];
    const pack = foldStock(items, moves, sales).get(PACK)!;
    expect(pack.on_hand).toBe(40 + 30 - 2 - 15 - 2);
    expect(pack.counted_at).toBe('2026-09-02T09:00:00Z');
    expect(pack.sold_since_count).toBe(17);
    expect(pack.last_sold_at).toBe('2026-09-04T15:00:00Z');
    expect(foldStock(items, moves, sales).has(CARTON)).toBe(false); // a carton has no stock of its own
  });

  it('without a count, stock starts at zero and can go negative (a count fixes it)', () => {
    const l = foldStock(items, [], [sale('2026-09-04T15:00:00Z', [{ item: MILK, qty: 2 }])]).get(MILK)!;
    expect(l.on_hand).toBe(-2);
  });

  it('dead stock: on the shelf and not sold in 60 days', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(isDeadStock({ on_hand: 5, last_sold_at: '2026-07-01T00:00:00Z' }, now)).toBe(true);
    expect(isDeadStock({ on_hand: 5, last_sold_at: '2026-09-01T00:00:00Z' }, now)).toBe(false);
    expect(isDeadStock({ on_hand: 0, last_sold_at: null }, now)).toBe(false);
    expect(isDeadStock({ on_hand: 3, last_sold_at: null }, now)).toBe(true);
  });

  it('a pack size needs the item it breaks into', () => {
    expect(ItemStockSettingsInput.safeParse({ track_stock: true, stock_ratio: 10 }).success).toBe(false);
    expect(ItemStockSettingsInput.safeParse({ track_stock: true, stock_of: PACK, stock_ratio: 10 }).success).toBe(true);
  });
});
