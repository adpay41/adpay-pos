/**
 * Phase 7 API: refunds and voids of completed sales reach the ledger, the reports and the alerts.
 * Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { CashReport, SalesSummary } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts } from '../services/alerts';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let ownerA: string;
let deviceA: string;
let maria: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  ownerA = await merchantLogin(app, a.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

let seq = 5000;
function ev(type: string, payload: unknown, sale: string | null) {
  return {
    event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++, occurred_at: new Date().toISOString(),
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't',
    actor_user_id: maria, type, payload,
  };
}
const push = (events: unknown[]) => app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });

/** A cash sale of one $40.00 non-taxable item. */
function sale40() {
  const sale = randomUUID();
  const line = randomUUID();
  return {
    sale,
    line,
    events: [
      ev('sale.opened', { cashier_user_id: maria, catalog_version: 1 }, sale),
      ev('sale.line_added', { line_id: line, item_id: randomUUID(), name: 'Phone charger', category_id: null, qty: 1, unit_cash_price_cents: 4_000, unit_card_price_cents: 4_160, taxable: false, tax_rate_ppm: 0, min_age: null }, sale),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 4_000, tendered_cents: 4_000, change_cents: 0, card: null }, sale),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 4_000, tax_cents: 0, total_cents: 4_000 }, sale),
    ],
  };
}

describe('refunds and voids', () => {
  it('a refund by line is stored with its lines; a voided completed sale leaves the gross, both show as refunds', async () => {
    // Built in device order: the drawer opens before the sales (device_seq decides the fold's order).
    const opened = ev('drawer.session_opened', { session_id: randomUUID(), float_cents: 10_000 }, null);
    const kept = sale40();
    const returned = sale40();
    const voided = sale40();
    const r = await push([
      opened,
      ...kept.events,
      ...returned.events,
      ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: 4_000, reason: 'Returned', by_user_id: maria, card: null, lines: [{ line_id: returned.line, qty: 1 }] }, returned.sale),
      ...voided.events,
      ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: 4_000, reason: 'Void: changed mind', by_user_id: maria, card: null, lines: [{ line_id: voided.line, qty: 1 }] }, voided.sale),
      ev('sale.voided', { reason: 'changed mind', by_user_id: maria }, voided.sale),
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rejected).toEqual([]);

    const timeline = (await app.inject({ method: 'GET', url: `/merchant/sales/${returned.sale}`, headers: auth(ownerA) })).json();
    expect(timeline.folded.refunded_qty).toEqual({ [returned.line]: 1 });

    const sum = (await app.inject({ method: 'GET', url: '/merchant/sales/summary?range=today', headers: auth(ownerA) })).json() as SalesSummary;
    // Two completed, not-voided sales count ($80); the voided one doesn't. Refunds show $80 (the return + the void).
    expect(sum.sale_count).toBe(2);
    expect(sum.gross_cents).toBe(8_000);
    expect(sum.refunds_cents).toBe(8_000);
    expect(sum.voids).toBe(1);

    const cash = (await app.inject({ method: 'GET', url: '/merchant/cash?range=today', headers: auth(ownerA) })).json() as CashReport;
    // float 100 + 3 × 40 cash in − 2 × 40 back = 140
    expect(cash.sessions[0]).toMatchObject({ cash_sales_cents: 12_000, cash_refunds_cents: 8_000, expected_cents: 14_000 });
  });

  it('a refund or void over $25 raises an alert naming who did it; smaller ones do not', async () => {
    const r = await evaluateAlerts(db, null, new Date());
    const big = r.opened.filter((x) => x.rule === 'large_refund');
    expect(big.map((x) => x.title).sort()).toEqual(['Register 1: $40.00 refunded by Maria Santos', 'Register 1: $40.00 voided by Maria Santos']);

    const small = sale40();
    await push([...small.events, ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: 999, reason: 'Returned', by_user_id: maria, card: null, lines: [] }, small.sale)]);
    expect((await evaluateAlerts(db, null, new Date())).opened.filter((x) => x.rule === 'large_refund')).toEqual([]);
  });
});
