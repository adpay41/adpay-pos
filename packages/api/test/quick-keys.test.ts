/**
 * Phase 2: photos, tile colors and order, per-location favorites. Runs on real Postgres in CI.
 */
import type { CatalogSnapshot } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { addStaff, auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let ownerB: string;
let deviceA: string;

// Smallest inputs the sniffer accepts: the real signatures followed by filler.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for tests')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (token: string): Promise<CatalogSnapshot> =>
  (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(token) })).json();

async function upload(token: string, body: Buffer, type = 'image/jpeg') {
  return app.inject({ method: 'POST', url: '/merchant/media', headers: { ...auth(token), 'content-type': type }, payload: body });
}

async function newItem(token: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(token), payload: { name, category_id: null, cash_price_cents: 199, ...extra } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().item_id;
}

describe('product photos', () => {
  it('uploads a photo, attaches it to an item, and serves it publicly with immutable caching', async () => {
    const up = await upload(ownerA, JPEG);
    expect(up.statusCode, up.body).toBe(201);
    const { media_id, url } = up.json();
    expect(url).toBe(`/media/${media_id}`);

    // Same bytes again → same id (content-addressed), no duplicate row.
    expect((await upload(ownerA, JPEG)).json().media_id).toBe(media_id);

    const id = await newItem(ownerA, 'Turkey club', { image_id: media_id, color: 'orange' });
    const item = (await snapshot(deviceA)).items.find((i) => i.item_id === id)!;
    expect(item.image_url).toBe(url);
    expect(item.color).toBe('orange');

    const img = await app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.rawPayload.equals(JPEG)).toBe(true);
  });

  it('rejects files that are not images, mislabeled images, and oversized uploads', async () => {
    const text = await upload(ownerA, Buffer.from('<svg onload=alert(1)>'), 'image/png');
    expect(text.statusCode).toBe(400);
    const mislabeled = await upload(ownerA, PNG, 'image/jpeg');
    expect(mislabeled.statusCode).toBe(400);
    expect(mislabeled.json().message).toContain('image/png');
    const big = await upload(ownerA, Buffer.concat([JPEG, Buffer.alloc(1_100_000)]));
    expect(big.statusCode).toBe(413);
    const svg = await app.inject({ method: 'POST', url: '/merchant/media', headers: { ...auth(ownerA), 'content-type': 'image/svg+xml' }, payload: '<svg/>' });
    expect(svg.statusCode).toBe(415);
  });

  it("an item cannot use another merchant's photo; cashiers cannot upload", async () => {
    const theirs = (await upload(ownerB, PNG, 'image/png')).json().media_id as string;
    const r = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { name: 'Stolen', category_id: null, cash_price_cents: 100, image_id: theirs } });
    expect(r.statusCode).toBe(400);

    await addStaff(db, a, 'cashier', 'Casey', '2015550188');
    const cashier = await merchantLogin(app, '201-555-0188');
    expect((await upload(cashier, JPEG)).statusCode).toBe(403);
  });

  it('media rows are immutable at the database level', async () => {
    await expect(db.query(`UPDATE media SET content_type = 'image/png'`)).rejects.toThrow();
    await expect(db.query('DELETE FROM media')).rejects.toThrow();
  });
});

describe('tile colors and order', () => {
  it('accepts only palette colors — never red, never free hex', async () => {
    for (const color of ['red', '#c8102e', 'green']) {
      const r = await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(ownerA), payload: { name: `Bad ${color}`, category_id: null, cash_price_cents: 100, color } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('new items go to the end of their category; reorder sets sort for items and categories in one write', async () => {
    const x = await newItem(ownerA, 'Zeta chips');
    const y = await newItem(ownerA, 'Alpha chips');
    let snap = await snapshot(deviceA);
    const sx = snap.items.find((i) => i.item_id === x)!.sort;
    expect(snap.items.find((i) => i.item_id === y)!.sort).toBe(sx + 1); // appended, not alphabetical

    const v = snap.catalog_version;
    const cats = snap.categories.map((c) => c.category_id).reverse();
    const r = await app.inject({ method: 'PUT', url: '/merchant/catalog/order', headers: auth(ownerA), payload: { items: [y, x], categories: cats } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().catalog_version).toBe(v + 1);

    snap = await snapshot(deviceA);
    expect(snap.items.find((i) => i.item_id === y)!.sort).toBe(0);
    expect(snap.items.find((i) => i.item_id === x)!.sort).toBe(1);
    expect(snap.categories.map((c) => c.category_id)).toEqual(cats);
  });

  it("reorder refuses another merchant's ids and leaves nothing half-applied", async () => {
    const mine = await newItem(ownerA, 'Mine');
    const before = (await snapshot(deviceA)).items.find((i) => i.item_id === mine)!.sort;
    const theirs = (await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(ownerB) })).json().items[0].item_id;
    const r = await app.inject({ method: 'PUT', url: '/merchant/catalog/order', headers: auth(ownerA), payload: { items: [theirs, mine] } });
    expect(r.statusCode).toBe(400);
    expect((await snapshot(deviceA)).items.find((i) => i.item_id === mine)!.sort).toBe(before);
  });
});

describe('favorites (per-location quick keys)', () => {
  it('sets an ordered favorites list that the register receives, audited, with a version bump', async () => {
    const one = await newItem(ownerA, 'Large coffee');
    const two = await newItem(ownerA, 'Newport 100s');
    const v = (await snapshot(deviceA)).catalog_version;
    const r = await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [two, one] } });
    expect(r.statusCode, r.body).toBe(200);
    const snap = await snapshot(deviceA);
    expect(snap.quick_keys).toEqual([two, one]);
    expect(snap.catalog_version).toBe(v + 1);

    const get = await app.inject({ method: 'GET', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA) });
    expect(get.json().item_ids).toEqual([two, one]);

    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'location.quick_keys_set' AND location_id = $1`, [a.location_id]);
    expect(rows[0]!.n).toBe(1);

    // Replace the list; clearing it works too.
    await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [one] } });
    expect((await snapshot(deviceA)).quick_keys).toEqual([one]);
    await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [] } });
    expect((await snapshot(deviceA)).quick_keys).toEqual([]);
  });

  it("rejects duplicates, another merchant's items, and another merchant's location", async () => {
    const one = await newItem(ownerA, 'Egg sandwich');
    const dup = await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [one, one] } });
    expect(dup.statusCode).toBe(400);
    const theirs = (await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(ownerB) })).json().items[0].item_id;
    const cross = await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [theirs] } });
    expect(cross.statusCode).toBe(400);
    const loc = await app.inject({ method: 'PUT', url: `/merchant/locations/${b.location_id}/quick-keys`, headers: auth(ownerA), payload: { item_ids: [] } });
    expect(loc.statusCode).toBe(404);
  });

  it('the admin scope can set favorites for any merchant', async () => {
    const one = await newItem(ownerB, 'Bravo coffee');
    await createAdmin(db, 'admin@qk.local', 'correct horse battery');
    const login = await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@qk.local', password: 'correct horse battery' } });
    const admin = login.json().token as string;
    const r = await app.inject({ method: 'PUT', url: `/admin/merchants/${b.merchant_id}/locations/${b.location_id}/quick-keys`, headers: auth(admin), payload: { item_ids: [one] } });
    expect(r.statusCode, r.body).toBe(200);
  });
});
