import type { CatalogSnapshot } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { addStaff, auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let admin: string;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let ownerB: string;
let deviceA: string;

async function adminLogin(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } });
  return r.json().token as string;
}

async function snapshot(token: string): Promise<CatalogSnapshot> {
  return (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(token) })).json();
}

async function version(token: string): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/device/catalog/version', headers: auth(token) })).json().catalog_version;
}

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  admin = await adminLogin();
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function categoryId(merchantId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ category_id: string }>('SELECT category_id FROM categories WHERE merchant_id = $1 AND name = $2', [merchantId, name]);
  return rows[0]!.category_id;
}

describe('catalog writes', () => {
  it('admin creates an item; the register sees it at a new catalog version with the derived card price', async () => {
    const before = await version(deviceA);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/merchants/${a.merchant_id}/items`,
      headers: auth(admin),
      payload: { name: 'Iced Tea 23 oz', category_id: await categoryId(a.merchant_id, 'Drinks'), cash_price_cents: 149, upc: '049000000443' },
    });
    expect(res.statusCode).toBe(201);
    const { item_id, catalog_version } = res.json();
    expect(catalog_version).toBe(before + 1);
    expect(await version(deviceA)).toBe(before + 1);

    const item = (await snapshot(deviceA)).items.find((i) => i.item_id === item_id)!;
    expect(item.cash_price_cents).toBe(149);
    expect(item.card_price_cents).toBe(155); // 149 + 4% (5.96 -> 6)
    expect(item.card_price_override).toBe(false);
    expect(item.open_price).toBe(false);
  });

  it('a price change records history, bumps the version and is audited with before/after', async () => {
    const created = await app.inject({
      method: 'POST', url: '/merchant/items', headers: auth(ownerA),
      payload: { name: 'Buttered Roll', category_id: await categoryId(a.merchant_id, 'Sandwiches'), cash_price_cents: 199, cost_cents: 60 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().item_id as string;

    const upd = await app.inject({
      method: 'PATCH', url: `/merchant/items/${id}`, headers: auth(ownerA),
      payload: { cash_price_cents: 225, card_price_cents: 235 },
    });
    expect(upd.statusCode).toBe(200);

    const hist = await app.inject({ method: 'GET', url: `/merchant/items/${id}/history`, headers: auth(ownerA) });
    const h = hist.json().history as { cash_price_cents: number; card_price_cents: number | null; changed_by_name: string }[];
    expect(h.map((x) => x.cash_price_cents)).toEqual([225, 199]);
    expect(h[0]!.card_price_cents).toBe(235);
    expect(h[0]!.changed_by_name).toBe('Alpha Owner');

    const item = (await snapshot(deviceA)).items.find((i) => i.item_id === id)!;
    expect(item.card_price_cents).toBe(235);
    expect(item.card_price_override).toBe(true);

    const { rows } = await db.query<{ details: { changed: Record<string, { from: number; to: number }> } }>(
      `SELECT details FROM audit_log WHERE action = 'catalog.item_updated' AND target = $1`, [id],
    );
    expect(rows[0]!.details.changed.cash_price_cents).toEqual({ from: 199, to: 225 });
  });

  it('a no-op update does not bump the version or write history', async () => {
    const created = await app.inject({
      method: 'POST', url: `/admin/merchants/${a.merchant_id}/items`, headers: auth(admin),
      payload: { name: 'Gum', category_id: null, cash_price_cents: 169 },
    });
    const id = created.json().item_id as string;
    const v = await version(deviceA);
    await app.inject({ method: 'PATCH', url: `/admin/merchants/${a.merchant_id}/items/${id}`, headers: auth(admin), payload: { cash_price_cents: 169 } });
    expect(await version(deviceA)).toBe(v);
    const { rows } = await db.query<{ n: number }>('SELECT count(*) AS n FROM item_price_history WHERE item_id = $1', [id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('price history is append-only at the database level', async () => {
    const { rows } = await db.query<{ history_id: string }>('SELECT history_id FROM item_price_history LIMIT 1');
    await expect(db.query('UPDATE item_price_history SET cash_price_cents = 1 WHERE history_id = $1', [rows[0]!.history_id])).rejects.toThrow(/append-only/);
  });

  it('changing the location dual-price % reprices derived card prices, not overrides', async () => {
    const snap = await snapshot(deviceA);
    const derived = snap.items.find((i) => !i.card_price_override && i.cash_price_cents === 699)!;
    const res = await app.inject({
      method: 'PATCH', url: `/merchant/locations/${a.location_id}/rates`, headers: auth(ownerA),
      payload: { dual_price_rate_ppm: 35_000 },
    });
    expect(res.statusCode).toBe(200);
    const after = await snapshot(deviceA);
    expect(after.catalog_version).toBeGreaterThan(snap.catalog_version);
    expect(after.dual_price_rate_ppm).toBe(35_000);
    expect(after.items.find((i) => i.item_id === derived.item_id)!.card_price_cents).toBe(723); // 699 + 3.5% = 723.47 -> 723
    for (const i of after.items.filter((x) => x.card_price_override)) {
      expect(i.card_price_cents).toBe(snap.items.find((x) => x.item_id === i.item_id)!.card_price_cents);
    }
  });

  it('rejects a card-price markup above 10% and float money', async () => {
    const r1 = await app.inject({ method: 'PATCH', url: `/merchant/locations/${a.location_id}/rates`, headers: auth(ownerA), payload: { dual_price_rate_ppm: 150_000 } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { name: 'X', category_id: null, cash_price_cents: 1.99 } });
    expect(r2.statusCode).toBe(400);
  });

  it('duplicate UPC or PLU in the same catalog is a 409, but other merchants may reuse it', async () => {
    const body = { name: 'Dup', category_id: null, cash_price_cents: 100, upc: '012345678905', plu: '4011' };
    expect((await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: body })).statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { ...body, plu: null } });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/barcode/);
    expect((await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerB), payload: body })).statusCode).toBe(201);
  });

  it('case barcodes and open-price items round-trip to the register', async () => {
    const res = await app.inject({
      method: 'POST', url: '/merchant/items', headers: auth(ownerA),
      payload: {
        name: 'Deli Meat (by the lb)', category_id: null, cash_price_cents: 0, open_price: true,
        barcodes: [{ barcode: '20000000001', pack_qty: 1 }],
      },
    });
    const pack = await app.inject({
      method: 'POST', url: '/merchant/items', headers: auth(ownerA),
      payload: { name: 'Water 24-pack', category_id: null, cash_price_cents: 1299, sell_unit: 'pack', pack_qty: 24, barcodes: [{ barcode: '10012345000017', pack_qty: 24 }] },
    });
    const snap = await snapshot(deviceA);
    const deli = snap.items.find((i) => i.item_id === res.json().item_id)!;
    expect(deli.open_price).toBe(true);
    expect(snap.items.find((i) => i.item_id === pack.json().item_id)!.barcodes).toEqual([{ barcode: '10012345000017', pack_qty: 24 }]);
  });

  it('categories: create, rename, deactivate; each bumps the version', async () => {
    const v0 = await version(deviceA);
    const c = await app.inject({ method: 'POST', url: '/merchant/categories', headers: auth(ownerA), payload: { name: 'Vape', taxable: true, min_age: 21, color: '#222222' } });
    expect(c.statusCode).toBe(201);
    const id = c.json().category_id as string;
    await app.inject({ method: 'PATCH', url: `/merchant/categories/${id}`, headers: auth(ownerA), payload: { name: 'Vape & E-cig', active: false } });
    expect(await version(deviceA)).toBe(v0 + 2);
    const cat = (await snapshot(deviceA)).categories.find((x) => x.category_id === id)!;
    expect(cat).toMatchObject({ name: 'Vape & E-cig', active: false, min_age: 21 });
  });
});

describe('browser access (CORS)', () => {
  it('allows the admin and merchant web apps to PATCH (preflight), and refuses unknown origins', async () => {
    const app2 = await createTestApp(db, { corsOrigins: ['http://localhost:3001'] });
    try {
      const ok = await app2.inject({
        method: 'OPTIONS',
        url: `/admin/merchants/${a.merchant_id}/items/00000000-0000-4000-8000-000000000000`,
        headers: { origin: 'http://localhost:3001', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' },
      });
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['access-control-allow-methods']).toContain('PATCH');
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3001');

      const evil = await app2.inject({
        method: 'OPTIONS',
        url: '/merchant/items',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app2.close();
    }
  });
});

describe('catalog permissions and tenancy', () => {
  it('a cashier can read but not write', async () => {
    await addStaff(db, a, 'cashier', 'Casey', '2015550177');
    const cashier = await merchantLogin(app, '201-555-0177');
    expect((await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(cashier) })).statusCode).toBe(200);
    const w = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(cashier), payload: { name: 'X', category_id: null, cash_price_cents: 100 } });
    expect(w.statusCode).toBe(403);
  });

  it("a merchant cannot edit another merchant's item, category or location", async () => {
    const snapB = (await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(ownerB) })).json() as CatalogSnapshot;
    const itemB = snapB.items[0]!.item_id;
    expect((await app.inject({ method: 'PATCH', url: `/merchant/items/${itemB}`, headers: auth(ownerA), payload: { cash_price_cents: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/merchant/categories/${snapB.categories[0]!.category_id}`, headers: auth(ownerA), payload: { name: 'hacked' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/merchant/locations/${b.location_id}/rates`, headers: auth(ownerA), payload: { dual_price_rate_ppm: 0 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/merchant/items/${itemB}/history`, headers: auth(ownerA) })).json().history).toEqual([]);
    // Nor put their item into another merchant's category.
    const cross = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { name: 'X', category_id: snapB.categories[0]!.category_id, cash_price_cents: 100 } });
    expect(cross.statusCode).toBe(400);
  });

  it('merchant users and devices cannot use the admin catalog routes', async () => {
    expect((await app.inject({ method: 'POST', url: `/admin/merchants/${a.merchant_id}/items`, headers: auth(ownerA), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/admin/merchants/${a.merchant_id}/locations`, headers: auth(deviceA) })).statusCode).toBe(403);
  });
});
