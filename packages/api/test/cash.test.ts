/**
 * Phase 6 API: cash drawer sessions folded on the server, the cash report, and the drawer alerts.
 * Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { CashReport } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts } from '../services/alerts';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let ownerB: string;
let deviceA: string;
let maria: string;
let dev: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
  dev = await addStaff(db, a, 'cashier', 'Dev Patel', null, '3690');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

let seq = 1000;
function ev(type: string, payload: unknown, actor: string, sale: string | null = null) {
  return {
    event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++, occurred_at: new Date().toISOString(),
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't',
    actor_user_id: actor, type, payload,
  };
}
const push = (events: unknown[]) => app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
const report = async (token: string): Promise<CashReport> => (await app.inject({ method: 'GET', url: '/merchant/cash?range=today', headers: auth(token) })).json();

function shift(actor: string, float: number, sales: number[], moves: [string, number][], counted: number) {
  const s = randomUUID();
  return [
    ev('drawer.session_opened', { session_id: s, float_cents: float }, actor),
    ...sales.map((amt) => {
      const sale = randomUUID();
      return ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: amt, tendered_cents: amt, change_cents: 0, card: null }, actor, sale);
    }),
    ...moves.map(([kind, amt]) => ev('drawer.cash_movement', { movement_id: randomUUID(), session_id: s, kind, amount_cents: amt, reason: kind === 'paid_out' ? 'Vendor delivery' : 'Safe drop', payee: null }, actor)),
    ev('drawer.opened', { reason: 'manual', by_user_id: actor }, actor),
    ev('drawer.session_closed', { session_id: s, counted_cents: counted, blind: true }, actor),
  ];
}

describe('cash report', () => {
  it('folds each session from events: expected, counted, over/short by cashier and by day, totals', async () => {
    // Maria: 200 + 15 + 27.50 − 45 paid out − 100 drop = 97.50 expected; counts 96.50 → $1 short.
    // Dev:   100 + 12 = 112 expected; counts 112.25 → 25¢ over.
    const r = await push([...shift(maria, 20_000, [1_500, 2_750], [['paid_out', 4_500], ['drop', 10_000]], 9_650), ...shift(dev, 10_000, [1_200], [], 11_225)]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rejected).toEqual([]);

    const c = await report(ownerA);
    expect(c.sessions).toHaveLength(2);
    const m = c.sessions.find((s) => s.opened_by === maria)!;
    expect(m).toMatchObject({ opened_by_name: 'Maria Santos', closed_by_name: 'Maria Santos', expected_cents: 9_750, counted_cents: 9_650, over_short_cents: -100, no_sale_opens: 1 });
    expect(m.movements.map((x) => x.reason)).toEqual(['Vendor delivery', 'Safe drop']);
    expect(c.by_cashier.map((x) => [x.name, x.over_short_cents]).sort()).toEqual([
      ['Dev Patel', 25],
      ['Maria Santos', -100],
    ]);
    expect(c.by_day).toHaveLength(1);
    expect(c.by_day[0]!.over_short_cents).toBe(-75);
    expect(c.totals).toMatchObject({ drops_cents: 10_000, paid_out_cents: 4_500, over_short_cents: -75, no_sale_opens: 2 });
  });

  it('is scoped to the merchant and needs reports.view', async () => {
    expect((await report(ownerB)).sessions).toEqual([]);
    await addStaff(db, a, 'cashier', 'Casey', '2015550190');
    const cashier = await merchantLogin(app, '201-555-0190');
    expect((await app.inject({ method: 'GET', url: '/merchant/cash', headers: auth(cashier) })).statusCode).toBe(403);
  });
});

describe('drawer alerts', () => {
  it('a drawer counted more than $5 short opens an alert naming the register and the amount', async () => {
    await push(shift(maria, 10_000, [2_000], [], 11_000)); // expected 120.00, counted 110.00 → $10 short
    const r = await evaluateAlerts(db, null, new Date());
    const short = r.opened.filter((x) => x.rule === 'drawer_short');
    expect(short).toHaveLength(1);
    expect(short[0]!.title).toContain('$10.00 short');
    // The $1 short shift from before is under the threshold.
    expect(r.opened.some((x) => x.rule === 'drawer_short' && x.title.includes('$1.00'))).toBe(false);
  });

  it('five or more no-sale opens on one register today is a spike', async () => {
    const opens = Array.from({ length: 5 }, () => ev('drawer.opened', { reason: 'manual', by_user_id: dev }, dev));
    await push(opens);
    const r = await evaluateAlerts(db, null, new Date());
    const spike = r.opened.find((x) => x.rule === 'no_sale_spike')!;
    expect(spike.title).toMatch(/opened \d+ times without a sale/);
    expect(spike.register_id).toBe(a.register_id);
  });
});
