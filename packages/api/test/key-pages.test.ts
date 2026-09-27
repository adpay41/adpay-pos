/**
 * Named key pages (ADR 0047): the owner saves their register tabs for a store; the register gets them
 * in its snapshot, in order; keys must be this merchant's items or departments. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogSnapshot } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let device: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Pages', '201-555-2170');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const url = () => `/merchant/locations/${a.location_id}/key-pages`;
const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();

describe('named key pages', () => {
  it('saves the pages in order and the register gets them in its snapshot', async () => {
    const { rows: items } = await db.query<{ item_id: string }>('SELECT item_id FROM items WHERE merchant_id = $1 LIMIT 2', [a.merchant_id]);
    const { rows: cats } = await db.query<{ category_id: string }>('SELECT category_id FROM categories WHERE merchant_id = $1 LIMIT 1', [a.merchant_id]);
    const before = (await snapshot()).catalog_version;
    const pages = [
      { name: 'Deli', keys: [{ kind: 'item', item_id: items[0]!.item_id }, { kind: 'department', category_id: cats[0]!.category_id, amount_cents: 1_000, label: '$10 deli' }] },
      { name: 'Coffee', keys: [{ kind: 'item', item_id: items[items.length - 1]!.item_id }, { kind: 'department', category_id: cats[0]!.category_id, amount_cents: null, label: null }] },
    ];
    const res = await app.inject({ method: 'PUT', url: url(), headers: auth(owner), payload: { pages } });
    expect(res.statusCode, res.body).toBe(200);
    const snap = await snapshot();
    expect(snap.catalog_version).toBeGreaterThan(before);
    expect(snap.key_pages!.map((p) => p.name)).toEqual(['Deli', 'Coffee']);
    expect(snap.key_pages![0]!.keys).toEqual(pages[0]!.keys);
    expect((await app.inject({ method: 'GET', url: url(), headers: auth(owner) })).json().pages).toHaveLength(2);

    // A save replaces the pages.
    await app.inject({ method: 'PUT', url: url(), headers: auth(owner), payload: { pages: [pages[1]] } });
    expect((await snapshot()).key_pages!.map((p) => p.name)).toEqual(['Coffee']);
  });

  it('refuses keys from another catalog and two pages with one name', async () => {
    const other = await app.inject({ method: 'PUT', url: url(), headers: auth(owner), payload: { pages: [{ name: 'X', keys: [{ kind: 'item', item_id: randomUUID() }] }] } });
    expect(other.statusCode).toBe(400);
    const dup = await app.inject({ method: 'PUT', url: url(), headers: auth(owner), payload: { pages: [{ name: 'Deli', keys: [] }, { name: 'deli', keys: [] }] } });
    expect(dup.statusCode).toBe(400);
  });
});
