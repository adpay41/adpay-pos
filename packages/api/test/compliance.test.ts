/**
 * Phase 10 API: tax & compliance tables — a location's rule set is saved, validated, scoped to the
 * merchant, resolved into the register's snapshot (rates by date, age by state), and a sale that
 * captured a deposit folds to the right total on the server. Real Postgres in CI.
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
let drinks: string;
let vapes: string;
let theirCategory: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  await addStaff(db, a, 'cashier', 'Maria Santos', '201-555-0199');
  cashierA = await merchantLogin(app, '201-555-0199');
  deviceA = await pairDevice(app, db, a.register_id);
  const cat = async (token: string, body: object) => (await app.inject({ method: 'POST', url: '/merchant/categories', headers: auth(token), payload: body })).json().category_id as string;
  drinks = await cat(ownerA, { name: 'Cold drinks' });
  vapes = await cat(ownerA, { name: 'Vapes', restriction: 'vape', tax_class: 'standard' });
  theirCategory = await cat(await merchantLogin(app, b.owner_phone), { name: 'Theirs' });
  await db.query(`INSERT INTO items (org_id, merchant_id, category_id, name, cash_price_cents) VALUES ($1, $2, $3, 'Water 16oz', 199), ($1, $2, $4, 'Vape pod', 1999)`, [
    a.org_id,
    a.merchant_id,
    drinks,
    vapes,
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(deviceA) })).json();
const put = (token: string, locationId: string, body: object) =>
  app.inject({ method: 'PUT', url: `/merchant/locations/${locationId}/compliance`, headers: auth(token), payload: body });
const DEPOSIT = randomUUID();

describe('tax & compliance settings', () => {
  it('defaults to none: the location rate, and state age rules applied through the restriction', async () => {
    const snap = await snapshot();
    expect(snap.compliance).toMatchObject({ tax_rates: [], charges: [], state: 'NJ', min_ages: { tobacco: 21, vape: 21, alcohol: 21, lottery: 18 } });
    const pod = snap.items.find((i) => i.name === 'Vape pod')!;
    expect(pod).toMatchObject({ restriction: 'vape', min_age: 21, tax_rate_ppm: 66_250 });
    expect(snap.categories.find((c) => c.category_id === vapes)).toMatchObject({ restriction: 'vape', tax_class: 'standard', min_age: null });
  });

  it('saved rules reach the register: dated rates resolve for today, charges and age overrides travel', async () => {
    const v = (await snapshot()).catalog_version;
    const body = {
      tax_rates: [
        { tax_class: 'standard', rate_ppm: 70_000, effective_from: '2020-01-01' },
        { tax_class: 'standard', rate_ppm: 99_000, effective_from: '2099-01-01' },
      ],
      charges: [{ rule_id: DEPOSIT, kind: 'deposit', label: 'Bottle deposit', amount_cents: 5, category_ids: [drinks], effective_from: '2020-01-01' }],
      age_rules: { lottery: 21 },
    };
    const r = await put(ownerA, a.location_id, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().catalog_version).toBe(v + 1);

    const snap = await snapshot();
    expect(snap.items.find((i) => i.name === 'Water 16oz')!.tax_rate_ppm).toBe(70_000); // the 2099 rate has not started
    expect(snap.compliance!.charges).toHaveLength(1);
    expect(snap.compliance!.min_ages.lottery).toBe(21);
    const got = (await app.inject({ method: 'GET', url: `/merchant/locations/${a.location_id}/compliance`, headers: auth(ownerA) })).json();
    expect(got.age_rules).toEqual({ lottery: 21 });
  });

  it('validates, and stays inside the merchant and behind catalog.edit', async () => {
    const bad = [
      { charges: [{ rule_id: randomUUID(), kind: 'deposit', label: 'x', effective_from: '2020-01-01' }] }, // no amount
      { tax_rates: [{ tax_class: 'standard', rate_ppm: 500_000, effective_from: '2020-01-01' }] }, // 50%
      { tax_rates: [{ tax_class: 'standard', rate_ppm: 1, effective_from: 'tomorrow' }] },
    ];
    for (const x of bad) expect((await put(ownerA, a.location_id, x)).statusCode).toBe(400);
    const foreign = { charges: [{ rule_id: randomUUID(), kind: 'deposit', label: 'x', amount_cents: 5, category_ids: [theirCategory], effective_from: '2020-01-01' }] };
    expect((await put(ownerA, a.location_id, foreign)).statusCode).toBe(400);
    expect((await put(ownerA, b.location_id, {})).statusCode).toBe(404);
    expect((await put(cashierA, a.location_id, {})).statusCode).toBe(403);
  });

  it('a sale that captured a deposit is stored and folds to the same total on the server', async () => {
    const sale_id = randomUUID();
    let seq = 0;
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: new Date().toISOString(),
      org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
    });
    // 6 × 199 + 6 × 5 deposit = 1224; tax 7% of 1194 = 83.58 → 84; total 1308
    const events = [
      ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev('sale.line_added', {
        line_id: randomUUID(), item_id: randomUUID(), name: 'Water 16oz', category_id: drinks, qty: 6, unit_cash_price_cents: 199, unit_card_price_cents: 207,
        taxable: true, tax_rate_ppm: 70_000, min_age: null, tax_class: 'standard',
        charges: [{ rule_id: DEPOSIT, kind: 'deposit', label: 'Bottle deposit', unit_cash_cents: 5, unit_card_cents: 5, taxable: false }],
      }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 1_308, tendered_cents: 2_000, change_cents: 692, card: null }),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 1_224, tax_cents: 84, total_cents: 1_308 }),
    ];
    const r = await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rejected).toEqual([]);
    const detail = (await app.inject({ method: 'GET', url: `/merchant/sales/${sale_id}`, headers: auth(ownerA) })).json();
    expect(detail.folded.mismatch).toBe(false);
    expect(detail.folded.cash.total_cents).toBe(1_308);
  });
});
