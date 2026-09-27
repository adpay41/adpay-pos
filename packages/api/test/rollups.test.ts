/**
 * Phase 19b API: the accountant role (read-only, never at a register), cashier performance, the
 * daily journal and its CSV, the multi-store roll-up, and the new alerts (big ticket, slow hour,
 * late first sale). Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts } from '../services/alerts';
import { ingestEvents } from '../services/events';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let maria: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Nineteen', '201-555-1901');
  owner = await merchantLogin(app, a.owner_phone);
  await pairDevice(app, db, a.register_id);
  maria = await addStaff(db, a, 'cashier', 'Maria Santos', null, '2468');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const dev = (t: Tenant) => ({ kind: 'device' as const, org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id });
function evFor(t: Tenant, at: string, actor: string | null = null) {
  return (sale_id: string | null, type: string, payload: unknown) => ({
    event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
    org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id, trace_id: 't', actor_user_id: actor, type, payload,
  });
}
/** A cash sale of `cents`, optionally with an age-restricted line (checked or not), optionally voided. */
function sale(t: Tenant, at: string, cents: number, opts: { actor?: string | null; age?: 'checked' | 'missed'; voided?: boolean; mode?: 'cash' | 'card' } = {}) {
  const ev = evFor(t, at, opts.actor ?? null);
  const id = randomUUID();
  const line = randomUUID();
  const mode = opts.mode ?? 'cash';
  const out = [
    ev(id, 'sale.opened', { cashier_user_id: opts.actor ?? null, catalog_version: 1 }),
    ev(id, 'sale.line_added', { line_id: line, item_id: randomUUID(), name: opts.age ? 'Beer' : 'Sandwich', category_id: null, qty: 1, unit_cash_price_cents: cents, unit_card_price_cents: cents, taxable: false, tax_rate_ppm: 0, min_age: opts.age ? 21 : null }),
  ];
  if (opts.age === 'checked') out.push(ev(id, 'sale.age_verified', { line_id: line, method: 'id_scan', verified_by_user_id: opts.actor ?? null, id_check: { age: 30, jurisdiction: 'NJ' } }));
  out.push(
    ev(id, 'sale.tender_added', {
      tender_id: randomUUID(), tender_type: mode, amount_cents: cents, tendered_cents: mode === 'cash' ? cents : null, change_cents: mode === 'cash' ? 0 : null,
      card: mode === 'card' ? { provider: 'stub', provider_ref: randomUUID(), status: 'approved', approval_code: 'A1', brand: 'visa', last4: '4242' } : null,
    }),
    ev(id, 'sale.completed', { price_mode: mode, subtotal_cents: cents, tax_cents: 0, total_cents: cents }),
  );
  if (opts.voided) out.push(ev(id, 'sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: cents, reason: 'Void', by_user_id: opts.actor ?? null, card: null, lines: [] }), ev(id, 'sale.voided', { reason: 'x', by_user_id: opts.actor ?? null }));
  return { id, events: out };
}
const ingest = (t: Tenant, events: object[], at: string) => ingestEvents(db, dev(t), events as never, { receivedAt: new Date(at) });

describe('accountant', () => {
  it('needs a phone and no PIN, never reaches the register, and only reads reports', async () => {
    const add = (payload: object) => app.inject({ method: 'POST', url: '/merchant/staff', headers: auth(owner), payload });
    expect((await add({ name: 'Cara CPA', role: 'accountant' })).statusCode).toBe(400);
    expect((await add({ name: 'Cara CPA', role: 'accountant', phone: '2015551977', pin: '1234' })).statusCode).toBe(400);
    const ok = await add({ name: 'Cara CPA', role: 'accountant', phone: '2015551977' });
    expect(ok.statusCode).toBe(201);
    const userId = ok.json().user_id as string;
    expect((await app.inject({ method: 'PUT', url: `/merchant/staff/${userId}/pin`, headers: auth(owner), payload: { pin: '1234' } })).statusCode).toBe(400);

    const cpa = await merchantLogin(app, '201-555-1977');
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(cpa) })).json();
    expect(me.principal.permissions).toEqual(['reports.view']);
    expect((await app.inject({ method: 'GET', url: '/merchant/reports/journal?from=2026-09-01&to=2026-09-30', headers: auth(cpa) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/merchant/customers', headers: auth(cpa) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/merchant/loyalty', headers: auth(cpa), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/merchant/staff', headers: auth(cpa), payload: { name: 'X', role: 'cashier' } })).statusCode).toBe(403);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND pin_hash IS NOT NULL`, [userId]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('cashier performance and the journal', () => {
  it('per cashier: sales, voids, refunds, no-sale opens, age checks done and missed, $/hour on the clock', async () => {
    const at = (h: number) => `2026-09-10T${String(h).padStart(2, '0')}:00:00.000Z`;
    const ev = evFor(a, at(13), maria);
    const events = [
      ev(null, 'staff.clocked_in', { user_id: maria }),
      ...sale(a, at(14), 1_000, { actor: maria }).events,
      ...sale(a, at(14), 2_000, { actor: maria, age: 'checked', mode: 'card' }).events,
      ...sale(a, at(15), 1_500, { actor: maria, age: 'missed' }).events,
      ...sale(a, at(15), 900, { actor: maria, voided: true }).events,
      evFor(a, at(16), maria)(null, 'drawer.opened', { reason: 'manual', by_user_id: maria }),
      evFor(a, at(17), maria)(null, 'staff.clocked_out', { user_id: maria, reason: 'manual' }),
    ];
    await ingest(a, events, at(17));
    const r = (await app.inject({ method: 'GET', url: '/merchant/reports/cashiers?from=2026-09-10&to=2026-09-10', headers: auth(owner) })).json();
    expect(r.cashiers.find((c: { user_id: string }) => c.user_id === maria)).toMatchObject({
      name: 'Maria Santos', sales: 3, gross_cents: 4_500, avg_ticket_cents: 1_500, minutes_on_clock: 240, per_hour_cents: 1_125,
      voids: 1, refunds: 0, no_sale_opens: 1, age_checks: 1, id_scans: 1, age_checks_missed: 1,
    });

    const j = (await app.inject({ method: 'GET', url: '/merchant/reports/journal?from=2026-09-10&to=2026-09-10', headers: auth(owner) })).json();
    expect(j.days).toEqual([expect.objectContaining({ date: '2026-09-10', net_sales_cents: 4_500, tax_cents: 0, gross_cents: 4_500, cash_cents: 2_500, card_cents: 2_000, refunds_cents: 0 })]);
    const csv = await app.inject({ method: 'GET', url: '/merchant/reports/journal.csv?from=2026-09-10&to=2026-09-10', headers: auth(owner) });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')[1]).toBe('2026-09-10,Nineteen Main St,45.00,0.00,45.00,0.00,25.00,20.00,0.00,0.00,0.00,0.00,0.00,0.00');
  });
});

describe('multi-store roll-up', () => {
  it('every store where this person may see reports, with totals; a cashier membership adds nothing', async () => {
    const b = await createTenant(db, 'Twenty', '201-555-2001');
    const c = await createTenant(db, 'TwentyOne', '201-555-2101');
    const { rows: me } = await db.query<{ user_id: string }>(`SELECT user_id FROM users WHERE phone = '+12015551901'`);
    await db.query(`INSERT INTO memberships (user_id, org_id, merchant_id, role) VALUES ($1, $2, $3, 'manager'), ($1, $4, $5, 'cashier')`, [
      me[0]!.user_id, b.org_id, b.merchant_id, c.org_id, c.merchant_id,
    ]);
    await pairDevice(app, db, b.register_id);
    await pairDevice(app, db, c.register_id);
    const now = new Date().toISOString();
    await ingest(b, sale(b, now, 3_300).events, now);
    await ingest(c, sale(c, now, 9_999).events, now);
    const r = (await app.inject({ method: 'GET', url: '/merchant/rollup?range=today', headers: auth(owner) })).json();
    expect(r.stores.map((s: { merchant_name: string }) => s.merchant_name).sort()).toEqual(['Nineteen Deli', 'Twenty Deli']);
    expect(r.stores.find((s: { merchant_name: string }) => s.merchant_name === 'Twenty Deli')).toMatchObject({ tickets: 1, gross_cents: 3_300, avg_ticket_cents: 3_300 });
    expect(r.total.gross_cents).toBeGreaterThanOrEqual(3_300);
  });
});

describe('alerts: big ticket, slow hour, late first sale', () => {
  const open = async (t: Tenant) => (await db.query<{ rule: string; title: string }>(`SELECT rule, title FROM alerts WHERE merchant_id = $1 AND resolved_at IS NULL`, [t.merchant_id])).rows;

  it('a sale at or above the store’s threshold', async () => {
    const t = await createTenant(db, 'BigTicket', '201-555-2201');
    await pairDevice(app, db, t.register_id);
    const now = new Date().toISOString();
    await ingest(t, sale(t, now, 25_000).events, now);
    await ingest(t, sale(t, now, 4_000).events, now);
    await evaluateAlerts(db, null, new Date());
    expect((await open(t)).filter((x) => x.rule === 'big_ticket').map((x) => x.title)).toEqual(['Register 1: $250.00 sale']);
  });

  it('the last hour well under the same hour on the last four same weekdays', async () => {
    const t = await createTenant(db, 'SlowHour', '201-555-2301');
    await pairDevice(app, db, t.register_id);
    // Thursdays, 10:30 New York time (14:30Z in September).
    for (const d of ['2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17']) await ingest(t, sale(t, `${d}T14:30:00.000Z`, 10_000).events, `${d}T14:31:00.000Z`);
    await ingest(t, sale(t, '2026-09-24T14:30:00.000Z', 1_000).events, '2026-09-24T14:31:00.000Z');
    await evaluateAlerts(db, null, new Date('2026-09-24T15:05:00.000Z'));
    expect((await open(t)).filter((x) => x.rule === 'slow_hour').map((x) => x.title)).toEqual(['SlowHour Main St: 10am–11am took $10.00, usually $100.00']);
  });

  it('no sale yet, well past the usual first sale; a sale clears it', async () => {
    const t = await createTenant(db, 'LateOpen', '201-555-2401');
    await pairDevice(app, db, t.register_id);
    for (const d of ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) await ingest(t, sale(t, `${d}T11:00:00.000Z`, 500).events, `${d}T11:01:00.000Z`);
    await evaluateAlerts(db, null, new Date('2026-09-24T11:30:00.000Z'));
    expect((await open(t)).filter((x) => x.rule === 'late_first_sale')).toEqual([]); // 7:30, within 45 minutes of 7:00
    await evaluateAlerts(db, null, new Date('2026-09-24T12:00:00.000Z'));
    expect((await open(t)).filter((x) => x.rule === 'late_first_sale').map((x) => x.title)).toEqual(['LateOpen Main St: no sale yet today (usually by 7:00am)']);
    await ingest(t, sale(t, '2026-09-24T12:05:00.000Z', 500).events, '2026-09-24T12:05:30.000Z');
    await evaluateAlerts(db, null, new Date('2026-09-24T12:10:00.000Z'));
    expect((await open(t)).filter((x) => x.rule === 'late_first_sale')).toEqual([]);
  });
});
