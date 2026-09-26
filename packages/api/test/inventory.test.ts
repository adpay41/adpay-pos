/**
 * Phase 22 API: stock folded per store from counts, register deliveries and write-offs, app
 * movements and sales; case-break (a carton is 10 packs); low stock; expiring lots. Real Postgres.
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
let pack: string;
let carton: string;
let milk: string;
let seq = 0;
let deviceToken: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Stock', '201-555-2050');
  owner = await merchantLogin(app, a.owner_phone);
  deviceToken = await pairDevice(app, db, a.register_id);
  const add = async (payload: object) => (await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { category_id: null, ...payload } })).json().item_id as string;
  pack = await add({ name: 'Marlboro Red pack', cash_price_cents: 1400 });
  carton = await add({ name: 'Marlboro Red carton', cash_price_cents: 13500 });
  milk = await add({ name: 'Milk 1 gal', cash_price_cents: 499 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const put = (item: string, payload: object) => app.inject({ method: 'PUT', url: `/merchant/items/${item}/stock`, headers: auth(owner), payload });
const move = (payload: object) => app.inject({ method: 'POST', url: '/merchant/inventory/movements', headers: auth(owner), payload: { location_id: a.location_id, ...payload } });
const levels = async () => (await app.inject({ method: 'GET', url: `/merchant/inventory?location_id=${a.location_id}`, headers: auth(owner) })).json();
const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (sale_id: string | null, type: string, payload: unknown, at = new Date().toISOString()) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
});
async function sell(item: string, qty: number) {
  const id = randomUUID();
  await ingestEvents(db, device(), [
    ev(id, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev(id, 'sale.line_added', { line_id: randomUUID(), item_id: item, name: 'x', category_id: null, qty, unit_cash_price_cents: 100, unit_card_price_cents: 100, taxable: false, tax_rate_ppm: 0, min_age: null }),
    ev(id, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 100 * qty, tendered_cents: 100 * qty, change_cents: 0, card: null }),
    ev(id, 'sale.completed', { price_mode: 'cash', subtotal_cents: 100 * qty, tax_cents: 0, total_cents: 100 * qty }),
  ]);
}

describe('inventory', () => {
  it('tracking, a case-break, and the rules around it', async () => {
    expect((await move({ kind: 'count', item_id: pack, qty: 5 })).statusCode).toBe(400); // not tracked yet
    expect((await put(pack, { track_stock: true, reorder_point: 20 })).statusCode).toBe(200);
    expect((await put(carton, { track_stock: true, stock_of: pack, stock_ratio: 10 })).statusCode).toBe(200);
    expect((await put(pack, { track_stock: true, stock_of: carton, stock_ratio: 2 })).statusCode).toBe(400); // packs already break into it
    expect((await put(milk, { track_stock: true, reorder_point: 4, perishable: true })).statusCode).toBe(200);
  });

  it('count, a delivery scanned at the register, sales (a carton takes 10 packs), a write-off, low stock', async () => {
    await move({ kind: 'count', item_id: pack, qty: 30 });
    await new Promise((r) => setTimeout(r, 5));
    const receipt = randomUUID();
    await ingestEvents(db, device(), [ev(null, 'inventory.received', { receipt_id: receipt, item_id: carton, qty: 2, invoice_ref: 'INV-1', expires_on: null })]);
    await sell(pack, 4);
    await sell(carton, 1);
    await ingestEvents(db, device(), [ev(null, 'inventory.written_off', { item_id: pack, qty: 3, reason: 'damaged', note: null })]);
    const l = await levels();
    const p = l.items.find((i: { item_id: string }) => i.item_id === pack);
    expect(p).toMatchObject({ on_hand: 30 + 20 - 4 - 10 - 3, reorder_point: 20, low: false, packs: [{ item_id: carton, ratio: 10 }] });
    expect(l.items.find((i: { item_id: string }) => i.item_id === carton)).toBeUndefined(); // stock lives on the pack
    await sell(pack, 14);
    expect((await levels()).items.find((i: { item_id: string }) => i.item_id === pack)).toMatchObject({ on_hand: 19, low: true });
    // The register event and its movement row are one and the same: sending it again changes nothing.
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_movements WHERE receipt_id = $1`, [receipt]);
    expect(rows[0]!.n).toBe(1);
  });

  it('a perishable lot close to its date shows, capped at what is on the shelf', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await move({ kind: 'receive', item_id: milk, qty: 6, expires_on: tomorrow });
    await sell(milk, 2);
    expect((await levels()).expiring).toEqual([expect.objectContaining({ item_id: milk, name: 'Milk 1 gal', expires_on: tomorrow, qty: 4 })]);
  });

  it('the register reads its store levels for tile badges and sell-soon', async () => {
    const r = (await app.inject({ method: 'GET', url: '/device/stock', headers: auth(deviceToken) })).json();
    expect(r.items.find((i: { item_id: string }) => i.item_id === pack)).toEqual({ item_id: pack, on_hand: 19, reorder_point: 20 });
    expect(r.expiring.map((x: { item_id: string }) => x.item_id)).toEqual([milk]);
  });

  it('shrink: a count short of what was expected, and write-offs by reason, at cost', async () => {
    await app.inject({ method: 'PATCH', url: `/merchant/items/${pack}`, headers: auth(owner), payload: { cost_cents: 1_000 } });
    await move({ kind: 'count', item_id: pack, qty: 15 }); // the fold expected 19: 4 missing
    const today = new Date().toISOString().slice(0, 10);
    const r = (await app.inject({ method: 'GET', url: `/merchant/inventory/shrink?location_id=${a.location_id}&from=${today}&to=${today}`, headers: auth(owner) })).json();
    expect(r.items.find((i: { key: string }) => i.key === pack)).toMatchObject({ missing_units: 4, written_off_units: 3, cost_cents: 7 * 1_000 });
    expect(r.by_reason).toEqual([{ reason: 'damaged', units: 3, cost_cents: 3_000 }]);
    expect(Array.isArray(r.cashiers)).toBe(true);
  });

  it('movements are append-only', async () => {
    await expect(db.query(`UPDATE inventory_movements SET qty = 999 WHERE item_id = $1`, [pack])).rejects.toThrow();
  });
});
