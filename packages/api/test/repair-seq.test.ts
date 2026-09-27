/**
 * Re-pairing a register that already has history (a new device, a cleared browser, an RMA swap):
 * pairing hands back the highest device_seq the server holds, so the new device numbers its events
 * after it and the register's events stay one sequence; the drawer fold also orders by time, so a
 * register whose history was already interleaved still folds its sessions correctly.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { cashReport } from '../services/cash';
import { ingestEvents } from '../services/events';
import { issueSetupCode } from '../services/onboarding';
import { cashSaleEvents, createTenant, createTestApp, createTestDb, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let t: Tenant;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  t = await createTenant(db, 'Repair', '201-555-2130');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const pair = async () => {
  const { code } = await db.tx((q) => issueSetupCode(q, t.register_id, null));
  return (await app.inject({ method: 'POST', url: '/auth/device/pair', payload: { setup_code: code } })).json() as { device_token: string; seq_floor: number; last_z_number: number };
};
const device = () => ({ kind: 'device' as const, org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id });

describe('re-pairing a register with history', () => {
  it('pairing returns the highest device_seq the server has for the register', async () => {
    expect((await pair()).seq_floor).toBe(-1);
    await ingestEvents(db, device(), cashSaleEvents(t, { seqStart: 0 }).events); // seqs 0..3
    expect((await pair()).seq_floor).toBe(3);
    await ingestEvents(db, device(), [
      { event_id: randomUUID(), schema_version: 1, sale_id: null, device_seq: 4, occurred_at: new Date().toISOString(), org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id, trace_id: 't', type: 'eod.closed', payload: { z_number: 7, business_date: new Date().toISOString().slice(0, 10), from_seq: 0, to_seq: 4, totals: { sales_count: 1, gross_cents: 1491, tax_cents: 93, voids: 0, cash_cents: 1491, card_cents: 0, refunds_cents: 0 } } },
    ]);
    expect(await pair()).toMatchObject({ seq_floor: 4, last_z_number: 7 });
  });

  it('drawer sessions fold in time order even when two devices reused the same seqs', async () => {
    const ev = (seq: number, at: string, type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id: null, device_seq: seq, occurred_at: at,
      org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id, trace_id: 't', type, payload,
    });
    const old = randomUUID();
    const fresh = randomUUID();
    const h = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    // The old device opened a session and never closed it; the new one (seqs restarted) opened and closed its own.
    await ingestEvents(db, device(), [ev(20, h(5), 'drawer.session_opened', { session_id: old, float_cents: 5000 })]);
    await ingestEvents(db, device(), [
      ev(10, h(1), 'drawer.session_opened', { session_id: fresh, float_cents: 10000 }),
      ev(30, h(0.5), 'drawer.session_closed', { session_id: fresh, counted_cents: 10000, blind: true }),
    ]);
    const r = await cashReport(db, t.merchant_id, 'today');
    // The old session ended when the new one began; the new one is closed: nothing is open now.
    expect(r.open_now).toEqual([]);
    expect(r.sessions.find((s) => s.session_id === fresh)?.closed_at).not.toBeNull();
  });
});

describe('demo setup codes', () => {
  it('a reusable (demo) code pairs again and moves the register; an install-kit code is single-use', async () => {
    const { hashSetupCode } = await import('../auth/crypto');
    const code = 'DEMO-REUSE';
    await db.query(
      `INSERT INTO register_setup_codes (code_hash, org_id, merchant_id, location_id, register_id, expires_at, reusable)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day', true)`,
      [hashSetupCode(code), t.org_id, t.merchant_id, t.location_id, t.register_id],
    );
    const pairWith = (c: string) => app.inject({ method: 'POST', url: '/auth/device/pair', payload: { setup_code: c } });
    const first = await pairWith(code);
    const second = await pairWith(code);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    // The first device is signed out of the register; the second one has it.
    expect((await app.inject({ method: 'GET', url: '/device/identity', headers: { authorization: `Bearer ${first.json().device_token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/device/identity', headers: { authorization: `Bearer ${second.json().device_token}` } })).statusCode).toBe(200);

    const { code: kit } = await db.tx((q) => issueSetupCode(q, t.register_id, null));
    expect((await pairWith(kit)).statusCode).toBe(200);
    expect((await pairWith(kit)).statusCode).toBe(400);
  });
});
