/**
 * Phase 16a API: Z-reports rebuilt from the synced events and checked against the register's
 * printout; the "end of day not closed" alert. Real Postgres in CI.
 */
import { buildZReport, parseRegisterEvent, zTotals } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts, listAlerts } from '../services/alerts';
import { ingestEvents } from '../services/events';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Mike', '201-555-1000');
  owner = await merchantLogin(app, a.owner_phone);
  await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (type: string, payload: unknown, at: Date, sale_id: string | null = null) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at.toISOString(),
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: null, type, payload,
});
function cashSale(amount: number, at: Date) {
  const sale = randomUUID();
  return [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }, at, sale),
    ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Thing', category_id: null, qty: 1, unit_cash_price_cents: amount, unit_card_price_cents: amount, taxable: false, tax_rate_ppm: 0, min_age: null }, at, sale),
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: amount, tendered_cents: amount, change_cents: 0, card: null }, at, sale),
    ev('sale.completed', { price_mode: 'cash', subtotal_cents: amount, tax_cents: 0, total_cents: amount }, at, sale),
  ];
}

describe('Z-reports', () => {
  const day = new Date('2026-09-21T16:00:00Z');
  it('the server rebuilds each Z from the same events; a printout that disagrees is flagged, not corrected', async () => {
    const events = [...cashSale(500, day), ...cashSale(725, day)];
    const z = buildZReport(events.map((e) => parseRegisterEvent(e)), { z_number: 1, register_id: a.register_id, business_date: '2026-09-21', from_seq: 0, categoryName: () => 'x' });
    const good = ev('eod.closed', { z_number: 1, business_date: '2026-09-21', from_seq: 0, to_seq: z.to_seq, totals: zTotals(z) }, new Date(day.getTime() + 3_600_000));
    await ingestEvents(db, device(), [...events, good], { receivedAt: day });

    const later = cashSale(300, new Date('2026-09-22T16:00:00Z'));
    const fromSeq = later[0]!.device_seq;
    // This register claims $9.99 for a Z whose events add up to $3.00.
    const bad = ev('eod.closed', { z_number: 2, business_date: '2026-09-22', from_seq: fromSeq, to_seq: later[3]!.device_seq, totals: { ...zTotals(z), sales_count: 1, gross_cents: 999, cash_cents: 999 } }, new Date('2026-09-22T20:00:00Z'));
    await ingestEvents(db, device(), [...later, bad], { receivedAt: new Date('2026-09-22T16:00:00Z') });

    const res = await app.inject({ method: 'GET', url: '/merchant/zreports?from=2026-09-21&to=2026-09-22', headers: auth(owner) });
    expect(res.statusCode, res.body).toBe(200);
    const { reports } = res.json();
    expect(reports.map((r: { z: { z_number: number; gross_cents: number }; mismatch: boolean }) => [r.z.z_number, r.z.gross_cents, r.mismatch])).toEqual([
      [2, 300, true],
      [1, 1_225, false],
    ]);
  });

  it('end of day not closed: a register that sold yesterday without a Z raises an alert after 1 a.m.', async () => {
    const yesterday = new Date('2026-09-23T18:00:00Z');
    await ingestEvents(db, device(), cashSale(400, yesterday), { receivedAt: yesterday });
    // 2:30 a.m. New York the next day.
    await evaluateAlerts(db, null, new Date('2026-09-24T06:30:00Z'));
    const open = await listAlerts(db, { merchantId: a.merchant_id, openOnly: true, limit: 20 });
    expect(open.find((x) => x.rule === 'eod_missing')?.title).toBe('Register 1: end of day for 2026-09-23 not closed (no Z-report)');
  });
});
