/**
 * Phase 15 API: cash in each drawer now with "drop needed", counterfeits in the cash report, the
 * drawer-over alert at the merchant's threshold, timesheets with weekly overtime and the payroll
 * CSV, the register's hourly pulse, and the count-sheet photo upload. Real Postgres in CI.
 */
import { type CashReport, type Timesheet } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts, listAlerts } from '../services/alerts';
import { ingestEvents } from '../services/events';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let device: string;
let maria: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Lima', '201-555-0900');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const principal = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (type: string, payload: unknown, at = new Date(), sale_id: string | null = null) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at.toISOString(),
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: maria, type, payload,
});
const push = (events: unknown[], receivedAt?: Date) => ingestEvents(db, principal(), events, receivedAt ? { receivedAt } : {});
const get = <T>(url: string) => app.inject({ method: 'GET', url, headers: auth(owner) }).then((r) => r.json() as T);

describe('cash now, counterfeits, drop alerts', () => {
  const session = randomUUID();
  it('an open drawer over the threshold shows "drop needed", raises an alert, and counterfeits are counted', async () => {
    const sale = randomUUID();
    await push([
      ev('drawer.session_opened', { session_id: session, float_cents: 20_000 }),
      ev('sale.opened', { cashier_user_id: maria, catalog_version: 1 }, new Date(), sale),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 45_000, tendered_cents: 45_000, change_cents: 0, card: null }, new Date(), sale),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 45_000, tax_cents: 0, total_cents: 45_000 }, new Date(), sale),
      ev('drawer.counterfeit', { session_id: session, denomination_cents: 10_000, note: null }),
    ]);
    const cash = await get<CashReport>('/merchant/cash?range=today');
    expect(cash.totals.counterfeits).toBe(1);
    expect(cash.open_now).toEqual([expect.objectContaining({ session_id: session, expected_cents: 65_000, drop_needed: true, suggest_cents: 44_000 })]);

    await evaluateAlerts(db, null, new Date());
    const open = await listAlerts(db, { merchantId: a.merchant_id, openOnly: true, limit: 20 });
    expect(open.find((x) => x.rule === 'drawer_over')?.title).toBe('Register 1: $650 in the drawer — drop needed');

    // A drop brings it under: the alert resolves on the next run.
    await push([ev('drawer.cash_movement', { movement_id: randomUUID(), session_id: session, kind: 'drop', amount_cents: 44_000, reason: 'Safe drop', payee: null })]);
    await evaluateAlerts(db, null, new Date());
    expect((await listAlerts(db, { merchantId: a.merchant_id, openOnly: true, limit: 20 })).some((x) => x.rule === 'drawer_over')).toBe(false);
  });

  it('the threshold is the merchant’s setting and reaches the register', async () => {
    expect((await app.inject({ method: 'PUT', url: '/merchant/alert-settings', headers: auth(owner), payload: { drop_over_cents: 100_000 } })).statusCode).toBe(200);
    const snap = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    expect(snap.cash_settings).toEqual({ drop_over_cents: 100_000 });
    expect((await get<CashReport>('/merchant/cash?range=today')).drop_over_cents).toBe(100_000);
  });
});

describe('time clock', () => {
  it('hours per day, weekly overtime over 40h, and the payroll CSV', async () => {
    // Five 9-hour days, Monday to Friday of a past week: 45 hours → 5 hours overtime.
    const monday = new Date('2026-09-14T12:00:00Z');
    const punches = [];
    for (let d = 0; d < 5; d++) {
      const start = new Date(monday.getTime() + d * 86_400_000);
      punches.push(ev('staff.clocked_in', { user_id: maria }, start), ev('staff.clocked_out', { user_id: maria, reason: 'manual' }, new Date(start.getTime() + 9 * 3_600_000)));
    }
    // Received the same day they happened (a register that synced normally).
    for (const p of punches) await push([p], new Date(p.occurred_at));

    const t = await get<Timesheet>('/merchant/timesheet?from=2026-09-14&to=2026-09-20');
    expect(t.rows).toEqual([expect.objectContaining({ name: 'Maria Santos', total_minutes: 45 * 60, overtime_minutes: 5 * 60, open_shift: false })]);
    expect(t.rows[0]!.by_day['2026-09-14']).toBe(540);

    const csv = await app.inject({ method: 'GET', url: '/merchant/timesheet.csv?from=2026-09-14&to=2026-09-20', headers: auth(owner) });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')[1]).toBe('Maria Santos,9:00,9:00,9:00,9:00,9:00,0:00,0:00,45:00,5:00');
    expect((await app.inject({ method: 'GET', url: '/merchant/timesheet?from=2026-01-01&to=2026-12-31', headers: auth(owner) })).statusCode).toBe(400);
  });
});

describe('register extras', () => {
  it('pulse: today so far vs yesterday by now, for the ribbon', async () => {
    const p = (await app.inject({ method: 'GET', url: '/device/pulse', headers: auth(device) })).json();
    expect(p.today_cents).toBe(45_000);
    expect(p).toHaveProperty('vs_yesterday_tenths');
  });
  it('uploads the count-sheet photo and serves it', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('count sheet')]);
    const r = await app.inject({ method: 'POST', url: '/device/media', headers: { ...auth(device), 'content-type': 'image/jpeg' }, payload: jpeg });
    expect(r.statusCode, r.body).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/media/${r.json().media_id}` })).statusCode).toBe(200);
  });
});
