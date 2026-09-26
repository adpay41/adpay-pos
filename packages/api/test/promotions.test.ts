/**
 * Phase 20a API: the promotions builder. A deal is validated against this merchant's catalog, reaches
 * the register snapshot while it runs, stops when ended, and reports what it gave from the sales'
 * own discount events. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogSnapshot } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let owner: string;
let device: string;
let drinks: string;
let otherItem: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Deals', '201-555-2020');
  b = await createTenant(db, 'Elsewhere', '201-555-2021');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  drinks = (await db.query<{ category_id: string }>(`INSERT INTO categories (org_id, merchant_id, name, sort, taxable) VALUES ($1, $2, 'Energy Drinks', 1, true) RETURNING category_id`, [a.org_id, a.merchant_id])).rows[0]!.category_id;
  otherItem = (await db.query<{ item_id: string }>(`INSERT INTO items (org_id, merchant_id, name, cash_price_cents) VALUES ($1, $2, 'Not yours', 100) RETURNING item_id`, [b.org_id, b.merchant_id])).rows[0]!.item_id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
const deal = { name: 'Energy drinks', rule: { kind: 'multi_price', qty: 2, price_cents: 500 }, category_ids: [] as string[], starts_on: '2026-09-01' };

describe('promotions builder', () => {
  it('a deal is checked against this store’s catalog and reaches the register while it runs', async () => {
    expect((await app.inject({ method: 'POST', url: '/merchant/promotions', headers: auth(owner), payload: { ...deal, item_ids: [otherItem] } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/merchant/promotions', headers: auth(owner), payload: { ...deal, category_ids: [drinks] } });
    expect(created.statusCode).toBe(201);
    const id = created.json().promo_id as string;
    expect((await snapshot()).promotions).toEqual([expect.objectContaining({ promo_id: id, name: 'Energy drinks', active: true, category_ids: [drinks] })]);

    // An ended deal leaves the register; one that ended yesterday never reaches it.
    await app.inject({ method: 'POST', url: `/merchant/promotions/${id}/end`, headers: auth(owner) });
    expect((await snapshot()).promotions).toEqual([]);
    await app.inject({ method: 'POST', url: `/merchant/promotions/${id}/resume`, headers: auth(owner) });
    await app.inject({ method: 'PUT', url: `/merchant/promotions/${id}`, headers: auth(owner), payload: { ...deal, category_ids: [drinks], ends_on: '2026-09-02' } });
    expect((await snapshot()).promotions).toEqual([]);
  });

  it('what a deal gave comes from the sales’ discount events', async () => {
    const id = (await app.inject({ method: 'POST', url: '/merchant/promotions', headers: auth(owner), payload: { ...deal, name: 'Two for five', category_ids: [drinks] } })).json().promo_id as string;
    const sale = randomUUID();
    const [l1, l2] = [randomUUID(), randomUUID()];
    let seq = 0;
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++, occurred_at: new Date().toISOString(),
      org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
    });
    const line = (line_id: string, cash: number) => ev('sale.line_added', { line_id, item_id: randomUUID(), name: 'Can', category_id: drinks, qty: 1, unit_cash_price_cents: cash, unit_card_price_cents: cash, taxable: false, tax_rate_ppm: 0, min_age: null });
    await ingestEvents(db, { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id }, [
      ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      line(l1, 299),
      line(l2, 329),
      ev('sale.line_discounted', { line_id: l1, cash_discount_cents: 60, card_discount_cents: 60, reason: 'Promo: Two for five', promo_id: id }),
      ev('sale.line_discounted', { line_id: l2, cash_discount_cents: 68, card_discount_cents: 68, reason: 'Promo: Two for five', promo_id: id }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 500, tendered_cents: 500, change_cents: 0, card: null }),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 500, tax_cents: 0, total_cents: 500 }),
    ]);
    const list = (await app.inject({ method: 'GET', url: '/merchant/promotions', headers: auth(owner) })).json();
    expect(list.promotions.find((p: { promo_id: string }) => p.promo_id === id)).toMatchObject({ uses_30d: 1, given_30d_cents: 128 });

    // A ticket voided before it was paid, and a line repriced twice, don't inflate what the deal gave.
    const voided = randomUUID();
    const l3 = randomUUID();
    const on = (saleId: string, type: string, payload: unknown) => ({ ...ev(type, payload), sale_id: saleId });
    await ingestEvents(db, { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id }, [
      on(voided, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      on(voided, 'sale.line_discounted', { line_id: l3, cash_discount_cents: 60, card_discount_cents: 60, reason: 'Promo: Two for five', promo_id: id }),
      on(voided, 'sale.line_discounted', { line_id: l3, cash_discount_cents: 90, card_discount_cents: 90, reason: 'Promo: Two for five', promo_id: id }),
      on(voided, 'sale.voided', { reason: 'customer left', by_user_id: null }),
    ]);
    const after = (await app.inject({ method: 'GET', url: '/merchant/promotions', headers: auth(owner) })).json();
    expect(after.promotions.find((p: { promo_id: string }) => p.promo_id === id)).toMatchObject({ uses_30d: 1, given_30d_cents: 128 });
  });

  it('another merchant can’t see or change them', async () => {
    const other = await merchantLogin(app, b.owner_phone);
    expect((await app.inject({ method: 'GET', url: '/merchant/promotions', headers: auth(other) })).json().promotions).toEqual([]);
    const mine = (await app.inject({ method: 'GET', url: '/merchant/promotions', headers: auth(owner) })).json().promotions[0].promo_id;
    expect((await app.inject({ method: 'POST', url: `/merchant/promotions/${mine}/end`, headers: auth(other) })).statusCode).toBe(404);
  });
});
