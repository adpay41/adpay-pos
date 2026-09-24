/**
 * Phase 11 API: the merchant app's live view. Sales by cashier, today vs yesterday vs the same day
 * last week cut at the same time of day, cashier and register names on the live feed and ticket
 * list, and per-merchant alert settings (mute, thresholds). Real Postgres in CI.
 */
import { localDate, type AlertSettings, type SaleListRow, type SalesCompare, type SalesSummary, type ServerMessage } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { Db } from '../db/db';
import { evaluateAlerts, listAlerts } from '../services/alerts';
import { ingestEvents } from '../services/events';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, testBackend, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let ownerA: string;
let maria: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Charlie', '973-555-0110');
  ownerA = await merchantLogin(app, a.owner_phone);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });

/** A completed cash sale of `amount` at `at`, rung by `actor`, received when it happened. */
function sale(amount: number, at: Date, actor: string | null = null) {
  const sale_id = randomUUID();
  const ev = (type: string, payload: unknown) => ({
    event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at.toISOString(),
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: actor, type, payload,
  });
  const events = [
    ev('sale.opened', { cashier_user_id: actor, catalog_version: 1 }),
    ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Thing', category_id: null, qty: 1, unit_cash_price_cents: amount, unit_card_price_cents: amount, taxable: false, tax_rate_ppm: 0, min_age: null }),
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: amount, tendered_cents: amount, change_cents: 0, card: null }),
    ev('sale.completed', { price_mode: 'cash', subtotal_cents: amount, tax_cents: 0, total_cents: amount }),
  ];
  return { sale_id, events, push: () => ingestEvents(db, device(), events, { receivedAt: at }) };
}

const get = <T>(url: string) => app.inject({ method: 'GET', url, headers: auth(ownerA) }).then((r) => r.json() as T);

describe('live merchant view', () => {
  const now = new Date();
  const min = 60_000;
  const day = 86_400_000;
  const tz = 'America/New_York';
  // Fixtures near a day boundary would land on the wrong date; the comparison needs same-date pairs.
  const sameDay = (x: Date, y: Date) => localDate(x, tz) === localDate(y, tz);
  const yEarly = new Date(now.getTime() - day - 2 * min);
  const yLate = new Date(now.getTime() - day + 2 * min);
  const wEarly = new Date(now.getTime() - 7 * day - 2 * min);
  const tNow = new Date(now.getTime() - 1_000);
  const safe = sameDay(yEarly, yLate) && sameDay(tNow, new Date(now.getTime() - 2 * min));

  it('today vs yesterday vs last week, cut at the same time of day', async () => {
    await sale(1_000, tNow, maria).push();
    await sale(500, tNow).push();
    await sale(1_000, yEarly, maria).push();
    await sale(700, yLate).push(); // later in the day than now: counts in yesterday's total, not "so far"
    await sale(400, wEarly).push();

    const c = await get<SalesCompare>('/merchant/sales/compare');
    const d = Object.fromEntries(c.days.map((x) => [x.key, x]));
    expect(d.today).toMatchObject({ date: localDate(now, tz), total_cents: 1_500, count: 2 });
    if (!safe) return; // within two minutes of local midnight: the fixture pairs straddle dates
    expect(d.yesterday).toMatchObject({ total_cents: 1_700, so_far_cents: 1_000, so_far_count: 1 });
    expect(d.last_week).toMatchObject({ total_cents: 400, so_far_cents: 400 });
    expect(c.vs_yesterday_tenths).toBe(500); // up 50%
    expect(c.vs_last_week_tenths).toBe(2_750); // up 275%
    expect(d.today!.by_hour.reduce((n, h) => n + h.amount_cents, 0)).toBe(1_500);
  });

  it('sales by cashier, and who rang each ticket', async () => {
    const s = await get<SalesSummary>('/merchant/sales/summary?range=today');
    expect(s.by_cashier).toEqual([
      { user_id: maria, name: 'Maria Santos', amount_cents: 1_000, count: 1 },
      { user_id: null, name: 'No one signed in', amount_cents: 500, count: 1 },
    ]);
    const { sales } = await get<{ sales: SaleListRow[] }>('/merchant/sales?limit=10');
    expect(sales.find((x) => x.total_cents === 1_000 && x.cashier_name === 'Maria Santos')).toBeTruthy();
  });

  it.skipIf(testBackend() !== 'postgres')('the live feed names the register and the cashier', async () => {
    const ws: WebSocket = await app.injectWS('/ws');
    const got: ServerMessage[] = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m)) as ServerMessage));
    ws.send(JSON.stringify({ type: 'auth', token: ownerA }));
    const until = async (pred: (m: ServerMessage) => boolean) => {
      for (let i = 0; i < 120 && !got.some(pred); i++) await new Promise((r) => setTimeout(r, 25));
      return got.find(pred);
    };
    expect(await until((m) => m.type === 'ready')).toBeTruthy();
    const s = sale(250, new Date(), maria);
    await s.push();
    const live = await until((m) => m.type === 'sale' && m.sale_id === s.sale_id);
    expect(live).toMatchObject({ type: 'sale', total_cents: 250, cashier_name: 'Maria Santos', register_name: 'Register 1 · Charlie Main St' });
    ws.terminate();
  });

  it('alert settings: a raised threshold holds an alert back; a muted rule is hidden from the merchant only', async () => {
    const defaults = await get<AlertSettings>('/merchant/alert-settings');
    expect(defaults).toEqual({ muted: [], large_refund_cents: 2_500, drawer_short_cents: 500, no_sale_spike: 5, drop_over_cents: 60_000 });

    const put = (body: object) => app.inject({ method: 'PUT', url: '/merchant/alert-settings', headers: auth(ownerA), payload: body });
    expect((await put({ large_refund_cents: 5_000 })).statusCode).toBe(200);
    expect((await put({ muted: ['queue_stuck'] })).statusCode).toBe(400); // not a merchant-facing rule
    expect((await put({ large_refund_cents: 5 })).statusCode).toBe(400);

    // A $30 refund: under this merchant's $50 threshold, so no alert.
    const s = sale(3_000, new Date(), maria);
    await s.push();
    const refund = (amount: number) =>
      ingestEvents(db, device(), [
        {
          event_id: randomUUID(), schema_version: 1, sale_id: s.sale_id, device_seq: seq++, occurred_at: new Date().toISOString(),
          org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: maria,
          type: 'sale.refunded', payload: { refund_id: randomUUID(), tender_type: 'cash', amount_cents: amount, reason: 'Returned', by_user_id: maria, card: null, lines: [] },
        },
      ]);
    await refund(3_000);
    await evaluateAlerts(db, null, new Date());
    const mine = () => listAlerts(db, { merchantId: a.merchant_id, openOnly: true, limit: 50 });
    expect((await mine()).filter((x) => x.rule === 'large_refund')).toEqual([]);

    // Back to the default $25: it opens. Then muted: the merchant no longer sees it; AD Pay still does.
    expect((await put({})).statusCode).toBe(200);
    await evaluateAlerts(db, null, new Date());
    expect((await mine()).filter((x) => x.rule === 'large_refund')).toHaveLength(1);
    expect((await put({ muted: ['large_refund'] })).statusCode).toBe(200);
    const inbox = await get<{ alerts: { rule: string }[] }>('/merchant/alerts');
    expect(inbox.alerts.filter((x) => x.rule === 'large_refund')).toEqual([]);
    expect((await mine()).find((x) => x.rule === 'large_refund')).toMatchObject({ muted: true });
  });
});
