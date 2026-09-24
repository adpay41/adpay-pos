/**
 * Phase 5 API: items created at the register (idempotent, aliasing duplicates), and the
 * sale-duration metric. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogSnapshot, SalesSummary } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, cashSaleEvents, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let deviceA: string;
let deviceA2: string;
let deviceB: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
  const { rows } = await db.query<{ register_id: string }>(
    `INSERT INTO registers (org_id, merchant_id, location_id, name) VALUES ($1, $2, $3, 'Register 2') RETURNING register_id`,
    [a.org_id, a.merchant_id, a.location_id],
  );
  deviceA2 = await pairDevice(app, db, rows[0]!.register_id);
  deviceB = await pairDevice(app, db, b.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (token: string): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(token) })).json();
const create = (token: string, body: object) => app.inject({ method: 'POST', url: '/device/items', headers: auth(token), payload: body });
const cmd = (over: Record<string, unknown> = {}) => ({
  item_id: randomUUID(), name: 'Goya Adobo', category_id: null, cash_price_cents: 349, upc: '041331021636',
  created_by_user_id: null, created_at: new Date().toISOString(), ...over,
});

describe('items created at the register', () => {
  it('creates the item with the device id, bumps the catalog, records history and audit; replays are no-ops', async () => {
    const v = (await snapshot(deviceA)).catalog_version;
    const c = cmd();
    const r = await create(deviceA, c);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ item_id: c.item_id, status: 'created', catalog_version: v + 1 });

    const snap = await snapshot(deviceA);
    expect(snap.items.find((i) => i.item_id === c.item_id)).toMatchObject({ name: 'Goya Adobo', upc: '041331021636', card_price_cents: 363 });
    const again = await create(deviceA, c);
    expect(again.json()).toMatchObject({ item_id: c.item_id, status: 'exists', catalog_version: v + 1 });

    const { rows: hist } = await db.query(`SELECT 1 FROM item_price_history WHERE item_id = $1 AND changed_by_kind = 'device'`, [c.item_id]);
    expect(hist).toHaveLength(1);
    const { rows: aud } = await db.query(`SELECT register_id FROM audit_log WHERE action = 'catalog.item_created_at_register' AND target = $1`, [c.item_id]);
    expect(aud[0]).toMatchObject({ register_id: a.register_id });
  });

  it('two registers creating the same barcode offline end up with one item; the second id is an alias', async () => {
    const first = cmd({ upc: '0012345678905', name: 'Plantain chips' });
    const second = cmd({ upc: '12345678905', name: 'Plantain Chips 3oz' }); // same product, UPC-A vs EAN-13 spelling
    await create(deviceA, first);
    const r = await create(deviceA2, second);
    expect(r.json()).toMatchObject({ item_id: first.item_id, status: 'aliased' });
    const snap = await snapshot(deviceA2);
    expect(snap.items.filter((i) => i.name.toLowerCase().startsWith('plantain'))).toHaveLength(1);
    // Replaying the aliased command still answers with the canonical id.
    expect((await create(deviceA2, second)).json()).toMatchObject({ item_id: first.item_id, status: 'aliased' });
  });

  it('a barcode already in the catalog (added in admin) is aliased too, not duplicated', async () => {
    const admin = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { name: 'Tostitos', category_id: null, cash_price_cents: 499, upc: '028400090896' } });
    const r = await create(deviceA, cmd({ upc: '028400090896', name: 'tostitos' }));
    expect(r.json()).toMatchObject({ item_id: admin.json().item_id, status: 'aliased' });
  });

  it("stays inside the merchant: another merchant's category is refused, the same UPC elsewhere is fine", async () => {
    const catB = (await snapshot(deviceB)).categories[0]!.category_id;
    expect((await create(deviceA, cmd({ upc: '000000001234', category_id: catB }))).statusCode).toBe(400);
    const r = await create(deviceB, cmd());
    expect(r.json().status).toBe('created');
    expect((await app.inject({ method: 'POST', url: '/device/items', headers: auth(ownerA), payload: cmd() })).statusCode).toBe(403);
  });

  it('validates strictly: no float money, no missing barcode', async () => {
    expect((await create(deviceA, cmd({ cash_price_cents: 3.49 }))).statusCode).toBe(400);
    expect((await create(deviceA, cmd({ upc: undefined }))).statusCode).toBe(400);
  });
});

describe('speed at the counter (sale duration)', () => {
  it('reports the median seconds from first action to completion, and how many were under 20 s', async () => {
    const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
    const events = [];
    for (const [i, secs] of [12, 18, 45].entries()) {
      const sale = cashSaleEvents(a, { seqStart: 100 + i * 10, occurredAt: at(0) });
      sale.events[sale.events.length - 1]!.occurred_at = at(secs);
      events.push(...sale.events);
    }
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    const s = (await app.inject({ method: 'GET', url: '/merchant/sales/summary?range=today', headers: auth(ownerA) })).json() as SalesSummary;
    expect(s.median_sale_seconds).toBe(18);
    expect(s.sales_under_20s).toBe(2);
  });
});
