/**
 * Phase 20b API: a bulk price change previews without writing, then applies in one catalog bump with a
 * history row per item; the profit report prices each unit at the cost in force when it was sold.
 * Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let soda: string;
let cola: string;
let lime: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Prices', '201-555-2030');
  owner = await merchantLogin(app, a.owner_phone);
  await pairDevice(app, db, a.register_id);
  soda = (await db.query<{ category_id: string }>(`INSERT INTO categories (org_id, merchant_id, name, sort, taxable) VALUES ($1, $2, 'Soda', 1, true) RETURNING category_id`, [a.org_id, a.merchant_id])).rows[0]!.category_id;
  const item = async (name: string, cash: number) =>
    (await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { name, category_id: soda, cash_price_cents: cash, cost_cents: 120 } })).json().item_id as string;
  cola = await item('Cola 20oz', 229);
  lime = await item('Lime soda 20oz', 249);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const bulk = (payload: object) => app.inject({ method: 'POST', url: '/merchant/catalog/bulk-price', headers: auth(owner), payload });

describe('bulk price change', () => {
  it('previews "+5% on all soda, rounded up to …9" without writing, then applies it with history', async () => {
    const version = async () => (await db.query<{ v: number }>('SELECT catalog_version AS v FROM merchants WHERE merchant_id = $1', [a.merchant_id])).rows[0]!.v;
    const v0 = await version();
    const preview = (await bulk({ category_ids: [soda], change: { kind: 'percent', ppm: 50_000 }, round: 'up_9', dry_run: true })).json();
    expect(preview).toMatchObject({ dry_run: true, changed: 2, below_cost: 0, catalog_version: null });
    expect(preview.sample.map((s: { name: string; from_cents: number; to_cents: number }) => [s.name, s.from_cents, s.to_cents])).toEqual([
      ['Cola 20oz', 229, 249], // 240.45 → 240 → 249
      ['Lime soda 20oz', 249, 269], // 261.45 → 261 → 269
    ]);
    expect(await version()).toBe(v0);

    const applied = (await bulk({ category_ids: [soda], change: { kind: 'percent', ppm: 50_000 }, round: 'up_9', dry_run: false })).json();
    expect(applied.catalog_version).toBe(v0 + 1);
    const history = (await app.inject({ method: 'GET', url: `/merchant/items/${cola}/history`, headers: auth(owner) })).json().history;
    expect(history[0]).toMatchObject({ cash_price_cents: 249 });
    expect(history).toHaveLength(2);
  });

  it('warns when a new price is below cost', async () => {
    expect((await bulk({ item_ids: [lime], change: { kind: 'set', cents: 99 }, dry_run: true })).json()).toMatchObject({ changed: 1, below_cost: 1 });
  });
});

describe('profit', () => {
  it('each unit at the cost when it was sold; margin by category', async () => {
    // Cola's cost rises to $1.50 after the first sale.
    const sell = async (at: string, cash: number) => {
      const id = randomUUID();
      let seq = 0;
      const ev = (type: string, payload: unknown) => ({
        event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: at,
        org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
      });
      await ingestEvents(db, { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id }, [
        ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
        ev('sale.line_added', { line_id: randomUUID(), item_id: cola, name: 'Cola 20oz', category_id: soda, qty: 2, unit_cash_price_cents: cash, unit_card_price_cents: cash, taxable: false, tax_rate_ppm: 0, min_age: null }),
        ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: cash * 2, tendered_cents: cash * 2, change_cents: 0, card: null }),
        ev('sale.completed', { price_mode: 'cash', subtotal_cents: cash * 2, tax_cents: 0, total_cents: cash * 2 }),
      ], { receivedAt: new Date(at) });
    };
    const before = new Date().toISOString();
    await sell(before, 249);
    await app.inject({ method: 'PATCH', url: `/merchant/items/${cola}`, headers: auth(owner), payload: { cost_cents: 150 } });
    await sell(new Date(Date.now() + 1_000).toISOString(), 249);
    const today = new Date().toISOString().slice(0, 10);
    const r = (await app.inject({ method: 'GET', url: `/merchant/reports/profit?from=${today}&to=${today}`, headers: auth(owner) })).json();
    // 4 units at $2.49; cost 2 × $1.20 + 2 × $1.50.
    expect(r.categories.find((c: { name: string }) => c.name === 'Soda')).toMatchObject({ units: 4, revenue_cents: 996, cost_cents: 540, units_without_cost: 0 });
    expect(r.below_cost_items).toEqual([]);
  });
});
