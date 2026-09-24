import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/db';
import {
  auth,
  cashSaleEvents,
  createAdmin,
  createTenant,
  createTestApp,
  createTestDb,
  merchantLogin,
  pairDevice,
  type Tenant,
} from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let deviceA: string;
let deviceB: string;
let ownerA: string;
let ownerB: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  deviceA = await pairDevice(app, db, a.register_id);
  deviceB = await pairDevice(app, db, b.register_id);
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('auth', () => {
  it('admin login succeeds with the right password only, and both attempts are audited', async () => {
    const bad = await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' },
    });
    expect(ok.statusCode).toBe(200);
    const token = ok.json().token as string;
    const auditRes = await app.inject({ method: 'GET', url: '/admin/audit', headers: auth(token) });
    const actions = auditRes.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('admin.login');
    expect(actions).toContain('admin.login_failed');
  });

  it('OTP codes are single-use and wrong codes fail', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/merchant/otp/request', payload: { phone: '(201) 555-0100' } });
    const { challenge_id, dev_code } = r.json();
    const wrong = dev_code === '000000' ? '111111' : '000000';
    expect((await app.inject({ method: 'POST', url: '/auth/merchant/otp/verify', payload: { challenge_id, code: wrong } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/merchant/otp/verify', payload: { challenge_id, code: dev_code } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/merchant/otp/verify', payload: { challenge_id, code: dev_code } })).statusCode).toBe(401);
  });

  it('unknown phone numbers get a challenge but no code', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/merchant/otp/request', payload: { phone: '609-555-0199' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().dev_code).toBeUndefined();
  });

  it('setup codes are single-use and re-pairing revokes the old device token', async () => {
    const tmp = await createTenant(db, 'Charlie', '973-555-0123');
    const first = await pairDevice(app, db, tmp.register_id);
    expect((await app.inject({ method: 'GET', url: '/device/identity', headers: auth(first) })).statusCode).toBe(200);
    const second = await pairDevice(app, db, tmp.register_id);
    expect((await app.inject({ method: 'GET', url: '/device/identity', headers: auth(first) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/device/identity', headers: auth(second) })).statusCode).toBe(200);
  });

  it('rejects a principal on the wrong kind of route', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/tenancy', headers: auth(ownerA) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/merchant/sales', headers: auth(deviceA) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(ownerA) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/merchant/sales' })).statusCode).toBe(401);
  });
});

describe('tenancy isolation', () => {
  it('a register cannot write events for another tenant', async () => {
    const { events } = cashSaleEvents(b);
    const res = await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toHaveLength(0);
    expect(res.json().rejected).toHaveLength(events.length);
  });

  it("a merchant user cannot read another merchant's sale, catalog location or tree", async () => {
    const { sale_id, events } = cashSaleEvents(b);
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceB), payload: { events } });

    expect((await app.inject({ method: 'GET', url: `/merchant/sales/${sale_id}`, headers: auth(ownerB) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/merchant/sales/${sale_id}`, headers: auth(ownerA) })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/merchant/catalog?location_id=${b.location_id}`, headers: auth(ownerA) })).statusCode,
    ).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/merchant/sales', headers: auth(ownerA) });
    expect(list.json().sales.map((s: { sale_id: string }) => s.sale_id)).not.toContain(sale_id);

    const tree = await app.inject({ method: 'GET', url: '/merchant/overview', headers: auth(ownerA) });
    const merchants = tree.json().orgs.flatMap((o: { merchants: { merchant_id: string }[] }) => o.merchants.map((m) => m.merchant_id));
    expect(merchants).toEqual([a.merchant_id]);
  });
});

describe('event ingest', () => {
  it('is idempotent: replaying a batch writes nothing new', async () => {
    const { sale_id, events } = cashSaleEvents(a);
    const first = await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    expect(first.json().accepted).toHaveLength(events.length);
    const again = await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    expect(again.json().accepted).toHaveLength(0);
    expect(again.json().duplicates).toHaveLength(events.length);

    const { rows } = await db.query<{ n: number }>('SELECT count(*) AS n FROM sale_events WHERE sale_id = $1', [sale_id]);
    expect(rows[0]!.n).toBe(events.length);
  });

  it('rejects bad events individually and keeps the good ones', async () => {
    const { events } = cashSaleEvents(a);
    const broken = { ...events[1]!, payload: { ...(events[1]!.payload as object), unit_cash_price_cents: 6.99 } };
    const res = await app.inject({
      method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events: [events[0], broken] },
    });
    expect(res.json().accepted).toEqual([events[0]!.event_id]);
    expect(res.json().rejected[0].reason).toContain('unit_cash_price_cents');
  });

  it('sale events are immutable at the database level', async () => {
    const { events } = cashSaleEvents(a);
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    const id = events[0]!.event_id;
    await expect(db.query(`UPDATE sale_events SET type = 'sale.voided' WHERE event_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM sale_events WHERE event_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE sale_events`)).rejects.toThrow(/append-only/);
  });

  it('creates monthly partitions on demand', async () => {
    const { ingestEvents } = await import('../services/events');
    const { events } = cashSaleEvents(a, { occurredAt: '2031-03-10T15:00:00.000Z' });
    const device = { kind: 'device' as const, ...a };
    const r = await ingestEvents(db, device, events, { receivedAt: new Date('2031-03-10T15:01:00.000Z') });
    expect(r.accepted).toHaveLength(events.length);
    const { rows } = await db.query<{ t: string | null }>(`SELECT to_regclass('sale_events_2031_03')::text AS t`);
    expect(rows[0]!.t).toBe('sale_events_2031_03');
  });

  it('reports are derived from events and reconcile with the tender', async () => {
    const t = await createTenant(db, 'Delta', '862-555-0177');
    const device = await pairDevice(app, db, t.register_id);
    const owner = await merchantLogin(app, t.owner_phone);
    for (let i = 0; i < 3; i++) {
      const { events } = cashSaleEvents(t);
      await app.inject({ method: 'POST', url: '/device/events', headers: auth(device), payload: { events } });
    }
    // A voided sale must not count.
    const voided = cashSaleEvents(t, { seqStart: 100 });
    const v = voided.events[0]!;
    const voidEvent = { ...v, event_id: crypto.randomUUID(), device_seq: 200, type: 'sale.voided', payload: { reason: 'test', by_user_id: null } };
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(device), payload: { events: [...voided.events, voidEvent] } });

    const res = await app.inject({ method: 'GET', url: '/merchant/sales/summary?range=today', headers: auth(owner) });
    const s = res.json();
    expect(s.sale_count).toBe(3);
    expect(s.gross_cents).toBe(3 * 1491);
    expect(s.tax_cents).toBe(3 * 93);
    expect(s.voids).toBe(1);
    expect(s.by_tender).toEqual([{ tender_type: 'cash', amount_cents: 3 * 1491, count: 3 }]);
  });
});

describe('catalog snapshot', () => {
  it('resolves dual prices at the location rate', async () => {
    const res = await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(deviceA) });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.cash_price_cents).toBe(699);
    expect(item.card_price_cents).toBe(727); // 699 + 4% (27.96 -> 28)
    expect(item.tax_rate_ppm).toBe(66_250);
  });
});
