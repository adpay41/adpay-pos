/**
 * Tax follows the category (tester feedback): the owner switches a category to "no tax" (medicine,
 * non-taxable grocery) and every item in it rings with no sales tax on the register's next snapshot;
 * switching it back taxes them at the store's rate again. Real Postgres in CI.
 */
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
  a = await createTenant(db, 'Taxes', '201-555-2140');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();

describe('tax by category', () => {
  it('a category switched to no tax rings its items with no tax, and back', async () => {
    const cat = (await app.inject({ method: 'POST', url: '/merchant/categories', headers: auth(owner), payload: { name: 'Vitamins/Medicine' } })).json();
    const categoryId = (cat.category_id ?? cat.category?.category_id) as string;
    await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { name: 'Aspirin 24ct', category_id: categoryId, cash_price_cents: 499 } });
    const rate = async () => (await snapshot()).items.find((i) => i.name === 'Aspirin 24ct')!;
    expect((await rate()).tax_rate_ppm).toBeGreaterThan(0);

    expect((await app.inject({ method: 'PATCH', url: `/merchant/categories/${categoryId}`, headers: auth(owner), payload: { taxable: false } })).statusCode).toBe(200);
    expect(await rate()).toMatchObject({ taxable: false, tax_rate_ppm: 0 });

    await app.inject({ method: 'PATCH', url: `/merchant/categories/${categoryId}`, headers: auth(owner), payload: { taxable: true } });
    expect((await rate()).tax_rate_ppm).toBeGreaterThan(0);
  });
});
