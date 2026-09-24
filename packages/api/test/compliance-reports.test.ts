/**
 * Phase 16b API: the sales-tax report (by month and rate, refunds' tax, voids excluded), the
 * compliance log of age checks (manual and ID-scan, no ID data), and the admin tax-tables view.
 * Real Postgres in CI.
 */
import type { SalesTaxReport } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { addStaff, auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let maria: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'November', '201-555-1100');
  owner = await merchantLogin(app, a.owner_phone);
  await pairDevice(app, db, a.register_id);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (sale_id: string, type: string, payload: unknown, at: Date) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at.toISOString(),
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: maria, type, payload,
});

/** A cash sale: `taxable` cents at 6.625% and `lottery` cents untaxed (21+ check on the taxable line, by ID scan). */
function sale(at: Date, taxable: number, lottery: number, opts: { refundOne?: boolean; voidIt?: boolean } = {}) {
  const id = randomUUID();
  const l1 = randomUUID();
  const tax = Math.floor((taxable * 66_250 * 2 + 1_000_000) / 2_000_000);
  const total = taxable + tax + lottery;
  const events = [
    ev(id, 'sale.opened', { cashier_user_id: maria, catalog_version: 1 }, at),
    ev(id, 'sale.line_added', { line_id: l1, item_id: randomUUID(), name: 'Cigarillos', category_id: null, qty: 1, unit_cash_price_cents: taxable, unit_card_price_cents: taxable, taxable: true, tax_rate_ppm: 66_250, min_age: 21, restriction: 'tobacco' }, at),
    ev(id, 'sale.age_verified', { line_id: l1, method: 'id_scan', verified_by_user_id: maria, id_check: { age: 34, jurisdiction: 'NJ' } }, at),
    ev(id, 'sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Scratch-Off', category_id: null, qty: 1, unit_cash_price_cents: lottery, unit_card_price_cents: lottery, taxable: false, tax_rate_ppm: 0, min_age: null }, at),
    ev(id, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: total, tendered_cents: total, change_cents: 0, card: null }, at),
    ev(id, 'sale.completed', { price_mode: 'cash', subtotal_cents: taxable + lottery, tax_cents: tax, total_cents: total }, at),
  ];
  if (opts.refundOne) events.push(ev(id, 'sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: taxable + tax, reason: 'Returned', by_user_id: maria, card: null, lines: [{ line_id: l1, qty: 1 }] }, at));
  if (opts.voidIt) events.push(ev(id, 'sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: total, reason: 'Void', by_user_id: maria, card: null, lines: [] }, at), ev(id, 'sale.voided', { reason: 'mistake', by_user_id: maria }, at));
  return events;
}

describe('sales-tax report', () => {
  it('by month and rate; a refund gives its tax back; a voided sale is not a sale', async () => {
    const jul = new Date('2026-07-10T16:00:00Z');
    const aug = new Date('2026-08-12T16:00:00Z');
    for (const [events, at] of [
      [sale(jul, 1_000, 500), jul],
      [sale(aug, 2_000, 0, { refundOne: true }), aug],
      [sale(aug, 3_000, 0, { voidIt: true }), aug],
    ] as const) await ingestEvents(db, device(), events, { receivedAt: at });

    const r = (await app.inject({ method: 'GET', url: '/merchant/reports/sales-tax?from=2026-07-01&to=2026-09-30', headers: auth(owner) })).json() as SalesTaxReport;
    // Jul: 1000 taxable (tax 66.25 → 66) + 500 lottery. Aug: 2000 taxable (tax 132.5 → 133), refunded with its tax.
    expect(r.by_month.map((m) => [m.period, m.sales_count, m.taxable_cents, m.non_taxable_cents, m.tax_cents, m.refunds_tax_cents])).toEqual([
      ['2026-07', 1, 1_000, 500, 66, 0],
      ['2026-08', 1, 2_000, 0, 133, 133],
    ]);
    expect(r.total).toMatchObject({ sales_count: 2, tax_cents: 199, refunds_tax_cents: 133, net_tax_cents: 66, by_rate: [{ rate_ppm: 66_250, taxable_cents: 3_000, tax_cents: 199 }] });

    const csv = await app.inject({ method: 'GET', url: '/merchant/reports/sales-tax.csv?from=2026-07-01&to=2026-09-30', headers: auth(owner) });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')).toHaveLength(5); // header, Jul, Aug, total, trailing newline
    expect((await app.inject({ method: 'GET', url: '/merchant/reports/sales-tax?from=2026-01-01&to=2026-12-31', headers: auth(owner) })).statusCode).toBe(400);
  });
});

describe('compliance log', () => {
  it('lists every age check with who, what and how, and never the ID itself', async () => {
    const { entries } = (await app.inject({ method: 'GET', url: '/merchant/reports/compliance?from=2026-07-01&to=2026-09-30', headers: auth(owner) })).json();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ register_name: 'Register 1', cashier_name: 'Maria Santos', item_name: 'Cigarillos', restriction: 'tobacco', min_age: 21, method: 'id_scan', scanned_age: 34, jurisdiction: 'NJ' });
    const csv = (await app.inject({ method: 'GET', url: '/merchant/reports/compliance.csv?from=2026-07-01&to=2026-09-30', headers: auth(owner) })).body;
    expect(csv.split('\n')[1]).toContain('ID scanned,34,NJ');
  });
});

describe('admin tax tables', () => {
  it('shows each location’s rate in force today and what is scheduled', async () => {
    await createAdmin(db);
    const admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token;
    await app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/compliance`, headers: auth(owner), payload: { tax_rates: [{ tax_class: 'standard', rate_ppm: 70_000, effective_from: '2099-01-01' }] } });
    const { locations } = (await app.inject({ method: 'GET', url: '/admin/tax-tables', headers: auth(admin) })).json();
    expect(locations.find((l: { location_id: string }) => l.location_id === a.location_id)).toMatchObject({ state: 'NJ', standard_rate_ppm: 66_250, upcoming: [{ tax_class: 'standard', rate_ppm: 70_000, effective_from: '2099-01-01' }] });
  });
});
