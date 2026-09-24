/**
 * Phase 14 API: catalog templates and CSV import (one bulk path, dry-run preview, price history),
 * and cashier usuals saved from the register and delivered in the snapshot. Real Postgres in CI.
 */
import type { CatalogSnapshot } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let cashierA: string;
let deviceA: string;
let maria: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Juliet', '201-555-0700');
  b = await createTenant(db, 'Kilo', '201-555-0800');
  ownerA = await merchantLogin(app, a.owner_phone);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', '201-555-0701', '2468');
  cashierA = await merchantLogin(app, '201-555-0701');
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const post = (url: string, payload: object, token = ownerA) => app.inject({ method: 'POST', url, headers: auth(token), payload });
const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(deviceA) })).json();

describe('catalog templates', () => {
  it('preview changes nothing; apply creates the categories and items once; applying again changes nothing', async () => {
    const before = await snapshot();
    const dry = (await post('/merchant/catalog/templates/cstore_starter/apply', { dry_run: true })).json();
    expect(dry.dry_run).toBe(true);
    expect(dry.created).toBeGreaterThan(70);
    expect((await snapshot()).items.length).toBe(before.items.length);
    expect((await snapshot()).catalog_version).toBe(before.catalog_version);

    const done = (await post('/merchant/catalog/templates/cstore_starter/apply', {})).json();
    expect(done.created).toBe(dry.created);
    const snap = await snapshot();
    expect(snap.items.length).toBe(before.items.length + done.created);
    expect(snap.catalog_version).toBe(before.catalog_version + 1);
    expect(snap.items.find((i) => i.name === 'Newport Menthol — Pack')).toMatchObject({ restriction: 'tobacco', card_price_cents: 1450 });
    expect(snap.items.find((i) => i.name === 'Coca-Cola 12 oz Cans — 12 Pack')).toMatchObject({ sell_unit: 'pack', pack_qty: 12 });

    const again = (await post('/merchant/catalog/templates/cstore_starter/apply', {})).json();
    expect(again).toMatchObject({ created: 0, updated: 0 });
    expect((await post('/merchant/catalog/templates/nope/apply', {})).statusCode).toBe(404);
  });
});

describe('CSV import', () => {
  const csv = 'Name,Category,Price,UPC,Cost\nHot Coffee — Medium,Drinks,2.49,,0.40\nArizona Iced Tea,Drinks,1.29,613008715236,\nMango Chamoy Candy,Candy,0.99,,\n';

  it('previews, then imports: updates by name with a price-history row, creates new items and categories', async () => {
    const preview = (await post('/merchant/catalog/import', { csv, dry_run: true })).json();
    expect(preview.parse.errors).toEqual([]);
    expect(preview.result).toMatchObject({ dry_run: true, created: 2, updated: 1, categories_created: ['Candy'] });
    expect(preview.result.sample.find((x: { name: string }) => x.name === 'Hot Coffee — Medium')).toMatchObject({ action: 'update', from_cents: 225, to_cents: 249 });

    const done = (await post('/merchant/catalog/import', { csv, dry_run: false })).json();
    expect(done.result).toMatchObject({ dry_run: false, created: 2, updated: 1 });
    const coffee = (await snapshot()).items.find((i) => i.name === 'Hot Coffee — Medium')!;
    expect(coffee).toMatchObject({ cash_price_cents: 249, cost_cents: 40 });
    const history = (await app.inject({ method: 'GET', url: `/merchant/items/${coffee.item_id}/history`, headers: auth(ownerA) })).json().history;
    expect(history[0]).toMatchObject({ cash_price_cents: 249, cost_cents: 40 });

    // Second import of a changed file matches the tea by its UPC even though it was renamed.
    const next = (await post('/merchant/catalog/import', { csv: 'Name,Price,UPC\nAZ Tea 23oz,1.49,613008715236\n', dry_run: false })).json();
    expect(next.result).toMatchObject({ created: 0, updated: 1 });
  });

  it('refuses a file with bad lines unless told to skip them; stays inside the merchant and behind catalog.edit', async () => {
    const bad = 'name,price\nGood Gum,1.00\nNo price,\n';
    expect((await post('/merchant/catalog/import', { csv: bad, dry_run: false })).statusCode).toBe(400);
    const skipped = (await post('/merchant/catalog/import', { csv: bad, dry_run: false, skip_errors: true })).json();
    expect(skipped.result.created).toBe(1);
    expect((await post('/merchant/catalog/import', { csv: bad, dry_run: true }, cashierA)).statusCode).toBe(403);
    const bSnap = (await app.inject({ method: 'GET', url: '/merchant/catalog', headers: auth(await merchantLogin(app, b.owner_phone)) })).json() as CatalogSnapshot;
    expect(bSnap.items.some((i) => i.name === 'Good Gum')).toBe(false);
  });
});

describe('the usual', () => {
  it('saved from the register for a staff member, delivered in the snapshot, removed again', async () => {
    const snap = await snapshot();
    const coffee = snap.items.find((i) => i.name === 'Hot Coffee — Medium')!;
    const newport = snap.items.find((i) => i.name === 'Newport Menthol — Pack')!;
    const dev = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth(deviceA), payload });

    const r = await dev('/device/usuals', { user_id: maria, label: 'Mike — coffee + Newports', lines: [{ item_id: coffee.item_id, qty: 1 }, { item_id: newport.item_id, qty: 1 }] });
    expect(r.statusCode, r.body).toBe(201);
    const after = await snapshot();
    expect(after.usuals).toEqual([{ usual_id: r.json().usual_id, user_id: maria, label: 'Mike — coffee + Newports', lines: [{ item_id: coffee.item_id, qty: 1 }, { item_id: newport.item_id, qty: 1 }] }]);
    expect(after.catalog_version).toBe(snap.catalog_version + 1);

    // Someone not on staff, or an item not in this catalog, is refused.
    expect((await dev('/device/usuals', { user_id: randomUUID(), label: 'x', lines: [{ item_id: coffee.item_id, qty: 1 }] })).statusCode).toBe(400);
    expect((await dev('/device/usuals', { user_id: maria, label: 'x', lines: [{ item_id: randomUUID(), qty: 1 }] })).statusCode).toBe(400);

    expect((await dev(`/device/usuals/${r.json().usual_id}/remove`, {})).statusCode).toBe(200);
    expect((await snapshot()).usuals).toEqual([]);
  });
});
