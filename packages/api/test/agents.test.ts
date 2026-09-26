/**
 * Phase 25b API: agents and referral partners — dated terms, stores assigned by referral code at
 * onboarding or by hand, and the monthly statement computed from the residual report (revenue or
 * margin split, bounty in the month of the first sale, margin pending until cost is entered).
 * Real Postgres in CI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, cashSaleEvents, createAdmin, createTenant, createTestApp, createTestDb, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let admin: string;

const month = new Date().toISOString().slice(0, 7);
const first = `${month}-01`;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Agented', '201-555-2110');
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth(admin), payload });
const plan = { kind: 'flat', rate_ppm: 0, per_txn_cents: 0, monthly_cents: 4_999, per_register_cents: 0, effective_from: first };

describe('agents', () => {
  it('a referral code at onboarding assigns the store; the statement pays the split and the bounty', async () => {
    const agent = await post('/admin/agents', {
      agent: { name: 'Ravi (Jersey City)', kind: 'agent', email: null, phone: null, referral_code: 'ravi01' },
      terms: { effective_from: first, basis: 'revenue', split_ppm: 200_000, bounty_cents: 5_000 },
    });
    expect(agent.statusCode).toBe(201);
    expect((await post('/admin/agents', { agent: { name: 'Dup', kind: 'referral', email: null, phone: null, referral_code: 'RAVI01' }, terms: { effective_from: first, basis: 'revenue', split_ppm: 0, bounty_cents: 0 } })).statusCode).toBe(400);

    const onboard = await post('/admin/onboarding', {
      org: { name: 'Referred Org' },
      merchant: { name: 'Referred Deli' },
      owner: { name: 'Owner', phone: '201-555-2111' },
      location: { name: 'Main', state: 'NJ', tax_rate_ppm: 66_250 },
      pricing: plan,
      referral_code: 'ravi01',
    });
    expect(onboard.statusCode).toBe(201);
    expect((await post('/admin/onboarding', { org: { name: 'X' }, merchant: { name: 'Y' }, owner: { name: 'Z', phone: '201-555-2112' }, location: { name: 'M', state: 'NJ', tax_rate_ppm: 0 }, pricing: plan, referral_code: 'NOPE1' })).statusCode).toBe(400);

    const agents = (await app.inject({ method: 'GET', url: '/admin/agents', headers: auth(admin) })).json().agents;
    expect(agents[0].stores.map((s: { merchant_name: string }) => s.merchant_name)).toEqual(['Referred Deli']);

    // No sale yet: revenue split only (the subscription), no bounty.
    let st = (await app.inject({ method: 'GET', url: `/admin/agents/statements?month=${month}`, headers: auth(admin) })).json().statements;
    expect(st[0].lines[0]).toMatchObject({ revenue_cents: 4_999, residual_cents: 999, bounty_cents: 0 });
    expect(st[0].total_cents).toBe(999);

    // First sale this month: the bounty is due.
    const merchantId = st[0].lines[0].merchant_id as string;
    const { rows } = await db.query<Tenant>(
      `SELECT m.org_id, m.merchant_id, l.location_id, r.register_id FROM merchants m JOIN locations l USING (merchant_id) JOIN registers r ON r.location_id = l.location_id WHERE m.merchant_id = $1 LIMIT 1`,
      [merchantId],
    );
    const t = rows[0]!;
    await ingestEvents(db, { kind: 'device', org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id }, cashSaleEvents(t).events);
    st = (await app.inject({ method: 'GET', url: `/admin/agents/statements?month=${month}`, headers: auth(admin) })).json().statements;
    expect(st[0]).toMatchObject({ residual_cents: 999, bounty_cents: 5_000, total_cents: 5_999, pending: 0 });

    const csv = (await app.inject({ method: 'GET', url: `/admin/agents/statements.csv?month=${month}`, headers: auth(admin) })).body;
    expect(csv).toContain('Referred Deli,revenue,20.0000,0.00,49.99,,9.99,50.00');
    expect(csv).toContain('TOTAL');
  });

  it('a margin split waits for the processor cost; assignment and terms are dated', async () => {
    const created = (
      await post('/admin/agents', {
        agent: { name: 'Corner ISO', kind: 'iso', email: 'iso@example.com', phone: null, referral_code: 'ISO22' },
        terms: { effective_from: first, basis: 'margin', split_ppm: 500_000, bounty_cents: 0 },
      })
    ).json() as { agent_id: string };
    await post(`/admin/merchants/${a.merchant_id}/pricing`, { plan });
    const assigned = await post(`/admin/merchants/${a.merchant_id}/agent`, { agent_id: created.agent_id, effective_from: first, note: null });
    expect(assigned.json().history[0]).toMatchObject({ agent_name: 'Corner ISO', effective_from: first });
    expect((await post(`/admin/merchants/${a.merchant_id}/agent`, { agent_id: created.agent_id, effective_from: `${month}-15` })).statusCode).toBe(400);

    const iso = () => app.inject({ method: 'GET', url: `/admin/agents/statements?month=${month}`, headers: auth(admin) }).then((r) => r.json().statements.find((s: { agent_name: string }) => s.agent_name === 'Corner ISO'));
    expect(await iso()).toMatchObject({ pending: 1, residual_cents: 0 });
    await app.inject({ method: 'PUT', url: `/admin/merchants/${a.merchant_id}/processor-cost`, headers: auth(admin), payload: { month, interchange_cents: 0, processor_fees_cents: 999, note: null } });
    expect(await iso()).toMatchObject({ pending: 0, residual_cents: 2_000 }); // (4999 − 999) × 50%

    // Terms can't be rewritten: a new row from next month leaves this month alone.
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    await post(`/admin/agents/${created.agent_id}/terms`, { effective_from: next, basis: 'margin', split_ppm: 100_000, bounty_cents: 0 });
    expect((await iso()).residual_cents).toBe(2_000);
    await expect(db.query('UPDATE agent_terms SET split_ppm = 1')).rejects.toThrow();
  });
});
