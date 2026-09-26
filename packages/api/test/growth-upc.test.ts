/**
 * Phase 25c API: the global UPC library (deduped across stores on the barcode key, store-made codes
 * never shared, typical price only from 3 stores), cohorts by first-sale month, and the investor pack
 * (monthly table from the ledger, CSV). Real Postgres in CI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, cashSaleEvents, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
const t: Tenant[] = [];
const owners: string[] = [];
let device: string;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  for (const [i, label] of ['Uno', 'Dos', 'Tres', 'Cuatro'].entries()) {
    t.push(await createTenant(db, label, `201-555-212${i}`));
    owners.push(await merchantLogin(app, t[i]!.owner_phone));
  }
  device = await pairDevice(app, db, t[3]!.register_id);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const item = (owner: string, name: string, cash: number, barcodes: { barcode: string; pack_qty: number }[], upc: string | null = null) =>
  app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { name, category_id: null, cash_price_cents: cash, upc, barcodes } });

describe('global UPC library', () => {
  it('dedupes one product across spellings and stores; store-made codes stay private', async () => {
    expect((await item(owners[0]!, 'Coke 20oz', 249, [], '036000291452')).statusCode).toBe(201);
    expect((await item(owners[1]!, 'COKE 20 OZ', 229, [{ barcode: '0036000291452', pack_qty: 1 }])).statusCode).toBe(201); // EAN-13 spelling
    expect((await item(owners[1]!, 'Deli roll', 199, [{ barcode: '400000000017', pack_qty: 1 }])).statusCode).toBe(201); // in-store code

    const lookup = (code: string) => app.inject({ method: 'GET', url: `/device/upc/${code}`, headers: auth(device) }).then((r) => r.json().suggestion);
    expect(await lookup('036000291452')).toMatchObject({ name: 'Coke 20oz', stores: 2, typical_cash_cents: null });
    expect(await lookup('400000000017')).toBeNull();

    await item(owners[2]!, 'Coca-Cola 20oz', 299, [], '036000291452');
    expect(await lookup('0036000291452')).toMatchObject({ stores: 3, typical_cash_cents: 249 });
    expect((await app.inject({ method: 'GET', url: '/merchant/upc/036000291452', headers: auth(owners[3]!) })).json().suggestion.name).toBe('Coke 20oz');

    const lib = (await app.inject({ method: 'GET', url: '/admin/upc-library?conflicts=1', headers: auth(admin) })).json();
    expect(lib).toMatchObject({ gtins: 1, shared: 1, conflicts: 1 });
    expect(lib.rows[0]).toMatchObject({ barcode_key: '36000291452', stores: 3, variants: 2 });
    expect((await app.inject({ method: 'GET', url: '/admin/upc-library?search=coke', headers: auth(admin) })).json().rows).toHaveLength(1);
  });
});

describe('cohorts and the investor pack', () => {
  it('cohort = month of the first sale; the pack is the ledger by month', async () => {
    let seq = 0;
    for (const x of t.slice(0, 2)) {
      const s = cashSaleEvents(x, { seqStart: seq });
      seq += s.events.length;
      await ingestEvents(db, { kind: 'device', org_id: x.org_id, merchant_id: x.merchant_id, location_id: x.location_id, register_id: x.register_id }, s.events);
    }
    const c = (await app.inject({ method: 'GET', url: '/admin/growth/cohorts', headers: auth(admin) })).json();
    expect(c.cohorts).toHaveLength(1);
    expect(c.cohorts[0]).toMatchObject({ cohort: c.month, stores: 2 });
    expect(c.cohorts[0].months[0]).toMatchObject({ offset: 0, active: 2, retention_tenths: 1000, sales_cents: 2 * 1491 });

    const pack = (await app.inject({ method: 'GET', url: '/admin/investor-pack', headers: auth(admin) })).json();
    expect(pack.months).toHaveLength(12);
    expect(pack.months.at(-1)).toMatchObject({ stores_started: 2, stores_active: 2, sales_cents: 2982, margin_cents: null });
    expect(pack.retention).toEqual({ m1: null, m3: null, m6: null });
    const csv = (await app.inject({ method: 'GET', url: '/admin/investor-pack.csv', headers: auth(admin) })).body;
    expect(csv.split('\n')[0]).toBe('month,stores_started,stores_active,sales,card_volume,revenue,subscription_revenue,processing_revenue,margin,margin_stores');
    expect(csv).toContain(',2,2,29.82,');
    expect((await app.inject({ method: 'GET', url: '/admin/investor-pack', headers: auth(owners[0]!) })).statusCode).toBe(403);
  });
});
