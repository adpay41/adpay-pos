/**
 * Phase 13 API: statement analyzer (manual entry), residual/margin report from the event log and
 * the plan in force, processor cost entry, and the KPI dashboard. Real Postgres in CI.
 */
import { localDate, type Kpis, type ResidualRow } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let admin: string;
let a: Tenant;
let quiet: Tenant;
let seq = 0;
const month = localDate(new Date(), 'America/New_York').slice(0, 7);

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token;
  a = await createTenant(db, 'Hotel', '201-555-0500');
  quiet = await createTenant(db, 'India', '201-555-0600');
  await pairDevice(app, db, a.register_id); // live
  await pairDevice(app, db, quiet.register_id); // live, but never sells
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, token = admin) => app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (sale_id: string, type: string, payload: unknown) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: new Date().toISOString(),
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
});
const card = (ref: string) => ({ provider: 'stub', provider_ref: ref, status: 'approved', approval_code: '1', brand: 'visa', last4: '4242' });

describe('statement analyzer', () => {
  const entry = {
    prospect: 'Bodega on 5th', processor: 'Clover', month: '2026-08', card_volume_cents: 4_200_000, transactions: 2_800, total_fees_cents: 138_600,
    interchange_cents: 100_800, pos_fees_cents: 7_900, registers: 2,
    offers: [{ kind: 'dual_pricing', dual_price_rate_ppm: 40_000, monthly_cents: 4_900, per_register_cents: 1_500, effective_from: '2026-09-01' }],
  };
  it('saves an entry and returns the analysis with each offer quoted', async () => {
    const r = await req('POST', '/admin/analyzer', entry);
    expect(r.statusCode, r.body).toBe(201);
    const one = (await req('GET', `/admin/analyzer/${r.json().analysis_id}`)).json();
    expect(one.analysis).toMatchObject({ effective_rate_ppm: 33_000, today_total_cents: 146_500 });
    expect(one.analysis.quotes[0]).toMatchObject({ merchant_cost_cents: 6_400, saving_cents: 140_100 });
    expect((await req('GET', '/admin/analyzer')).json().analyses).toHaveLength(1);
  });
  it('validates and is admin only', async () => {
    expect((await req('POST', '/admin/analyzer', { ...entry, offers: [] })).statusCode).toBe(400);
    expect((await req('POST', '/admin/analyzer', { ...entry, card_volume_cents: 1.5 })).statusCode).toBe(400);
    const owner = await merchantLogin(app, a.owner_phone);
    expect((await req('GET', '/admin/analyzer', undefined, owner)).statusCode).toBe(403);
  });
});

describe('residuals and KPIs', () => {
  it('card volume from the ledger (net of card refunds), revenue from the plan, margin once cost is entered', async () => {
    expect((await req('POST', `/admin/merchants/${a.merchant_id}/pricing`, { plan: { kind: 'dual_pricing', dual_price_rate_ppm: 40_000, monthly_cents: 4_900, effective_from: '2026-01-01' } })).statusCode).toBe(201);
    const s1 = randomUUID();
    const s2 = randomUUID();
    const s3 = randomUUID();
    await ingestEvents(db, device(), [
      ev(s1, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev(s1, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'card', amount_cents: 1_040_000, tendered_cents: null, change_cents: null, card: card('r1') }),
      ev(s1, 'sale.completed', { price_mode: 'card', subtotal_cents: 1_040_000, tax_cents: 0, total_cents: 1_040_000 }),
      ev(s2, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev(s2, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'card', amount_cents: 52_000, tendered_cents: null, change_cents: null, card: card('r2') }),
      ev(s2, 'sale.completed', { price_mode: 'card', subtotal_cents: 52_000, tax_cents: 0, total_cents: 52_000 }),
      ev(s2, 'sale.refunded', { refund_id: randomUUID(), tender_type: 'card', amount_cents: 52_000, reason: 'Returned', by_user_id: null, card: card('r2r'), lines: [] }),
      ev(s3, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev(s3, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 2_000, tendered_cents: 2_000, change_cents: 0, card: null }),
      ev(s3, 'sale.completed', { price_mode: 'cash', subtotal_cents: 2_000, tax_cents: 0, total_cents: 2_000 }),
    ]);

    let rows = (await req('GET', `/admin/residuals?month=${month}`)).json().rows as ResidualRow[];
    let r = rows.find((x) => x.merchant_id === a.merchant_id)!;
    // $10,400 card net of the $520 refunded sale; a +4% card price holds $400 of surcharge; $49 subscription.
    expect(r).toMatchObject({ plan_kind: 'dual_pricing', card_volume_cents: 1_040_000, card_transactions: 2, cash_volume_cents: 2_000, processing_revenue_cents: 40_000, subscription_revenue_cents: 4_900, cost_entered: false, margin_cents: null });

    expect((await req('PUT', `/admin/merchants/${a.merchant_id}/processor-cost`, { month, interchange_cents: 22_000, processor_fees_cents: 3_000 })).statusCode).toBe(200);
    // Entered again = corrected, not duplicated.
    expect((await req('PUT', `/admin/merchants/${a.merchant_id}/processor-cost`, { month, interchange_cents: 21_000, processor_fees_cents: 3_000, note: 'from Finix statement' })).statusCode).toBe(200);
    rows = (await req('GET', `/admin/residuals?month=${month}`)).json().rows;
    r = rows.find((x) => x.merchant_id === a.merchant_id)!;
    expect(r).toMatchObject({ cost_entered: true, cost_cents: 24_000, margin_cents: 44_900 - 24_000 });
    // A merchant with no plan earns nothing and is listed anyway.
    expect(rows.find((x) => x.merchant_id === quiet.merchant_id)).toMatchObject({ plan_kind: null, revenue_cents: 0 });
  });

  it('KPIs: live and active stores, the quiet list, volume, revenue, margin, installs', async () => {
    await req('POST', '/merchant/support', { body: 'hi' }, await merchantLogin(app, a.owner_phone));
    const k = (await req('GET', '/admin/kpis')).json() as Kpis;
    expect(k).toMatchObject({ month, stores_live: 2, stores_active_7d: 1, registers_paired: 2, card_volume_cents: 1_040_000, volume_cents: 1_042_000, revenue_cents: 44_900, margin_cents: 20_900, support_messages_7d: 1, support_unread: 1 });
    expect(k.effective_rate_ppm).toBe(38_462); // 400 / 10,400
    expect(k.stores_quiet_14d.map((x) => x.merchant_id)).toEqual([quiet.merchant_id]);
    expect(k.installs_by_week.reduce((n, w) => n + w.registers, 0)).toBe(2);
  });
});
