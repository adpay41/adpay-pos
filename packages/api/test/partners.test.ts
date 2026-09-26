/**
 * Phase 25a API: partner API keys (shown once, hashed at rest, scoped, one merchant, revocable) and
 * webhooks (URL rules, queued with the sale in the ingest transaction, signed, retried on schedule,
 * given up after the last attempt, redelivered by hand). Real Postgres in CI.
 */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBHOOK_MAX_ATTEMPTS } from '@adpay/shared';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { deliverWebhooks, type WebhookTransport } from '../services/partners';
import { auth, cashSaleEvents, createAdmin, createTenant, createTestApp, createTestDb, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let admin: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Partner', '201-555-2100');
  b = await createTenant(db, 'Other', '201-555-2101');
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const device = (t: Tenant) => ({ kind: 'device' as const, org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id });
async function sell(t: Tenant) {
  const s = cashSaleEvents(t, { seqStart: seq });
  seq += s.events.length;
  await ingestEvents(db, device(t), s.events);
  return s;
}
const today = () => new Date().toISOString().slice(0, 10);

describe('API keys', () => {
  it('shown once, hashed at rest, scoped to one merchant, revocable', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/api-keys', headers: auth(admin), payload: { merchant_id: a.merchant_id, name: 'Books app', scopes: ['sales:read'] } });
    expect(res.statusCode).toBe(201);
    const { key, key_id } = res.json() as { key: string; key_id: string };
    expect(key).toMatch(/^adp_[a-z0-9]{8}_/);
    const { rows } = await db.query<{ key_hash: string }>('SELECT key_hash FROM api_keys WHERE key_id = $1', [key_id]);
    expect(rows[0]!.key_hash).not.toContain(key.split('_')[2]!);
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/admin/api-keys', headers: auth(admin) })).json())).not.toContain(key);

    await sell(a);
    await sell(b);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(key) })).json();
    expect(me).toEqual({ merchant_id: a.merchant_id, scopes: ['sales:read'] });
    const sales = (await app.inject({ method: 'GET', url: `/v1/sales?from=${today()}&to=${today()}`, headers: auth(key) })).json().sales;
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ total_cents: 1491, tax_cents: 93, refunded_cents: 0, voided: false });
    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: auth(key) })).statusCode).toBe(403); // no catalog scope

    // A wrong secret with a real prefix, a merchant token, nothing: all 401.
    const forged = key.slice(0, 13) + 'x'.repeat(key.length - 13);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(forged) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(admin) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);

    expect((await app.inject({ method: 'POST', url: `/admin/api-keys/${key_id}/revoke`, headers: auth(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(key) })).statusCode).toBe(401);
  });
});

describe('webhooks', () => {
  it('URL rules: https to a public host; localhost only outside production; no private addresses', async () => {
    const make = (url: string) => app.inject({ method: 'POST', url: '/admin/webhooks', headers: auth(admin), payload: { merchant_id: a.merchant_id, url, events: ['sale.completed'] } });
    expect((await make('http://partner.example.com/hook')).statusCode).toBe(400);
    expect((await make('https://10.0.0.5/hook')).statusCode).toBe(400);
    expect((await make('https://user:pw@partner.example.com/hook')).statusCode).toBe(400);
    expect((await make('http://localhost:9999/hook')).statusCode).toBe(201); // test env
  });

  it('a sale queues a signed delivery; failures retry on schedule, then give up; redeliver sends it again', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/admin/webhooks', headers: auth(admin), payload: { merchant_id: b.merchant_id, url: 'https://partner.example.com/hook', events: ['sale.completed', 'sale.refunded'] } })
    ).json() as { endpoint_id: string; secret: string };
    const s = await sell(b);

    const sent: { headers: Record<string, string>; body: string }[] = [];
    const ok: WebhookTransport = { post: async (_u, headers, body) => (sent.push({ headers, body }), { status: 200 }) };
    const now = new Date();
    expect(await deliverWebhooks(db, ok, now)).toMatchObject({ delivered: 1 });
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({ type: 'sale.completed', merchant_id: b.merchant_id, data: { sale_id: s.sale_id, total_cents: 1491 } });
    expect(sent[0]!.body).not.toContain('receipt_token');
    const [t, v1] = sent[0]!.headers['adpay-signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(v1).toBe(createHmac('sha256', created.secret).update(`${t}.${sent[0]!.body}`).digest('hex'));
    // Delivered once; a second run sends nothing.
    expect(await deliverWebhooks(db, ok, now)).toMatchObject({ delivered: 0 });

    // A partner that's down: retried on schedule, then given up.
    await sell(b);
    const down: WebhookTransport = { post: async () => ({ status: 503 }) };
    let at = new Date();
    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      expect(await deliverWebhooks(db, down, at)).toMatchObject({ retrying: 1 });
      expect(await deliverWebhooks(db, down, at)).toMatchObject({ retrying: 0 }); // not due yet
      at = new Date(at.getTime() + 13 * 3_600_000);
    }
    expect(await deliverWebhooks(db, down, at)).toMatchObject({ failed: 1 });
    const deliveries = (await app.inject({ method: 'GET', url: `/admin/webhooks/${created.endpoint_id}/deliveries`, headers: auth(admin) })).json().deliveries as { delivery_id: string; status: string; attempts: number; last_error: string }[];
    const failed = deliveries.find((d) => d.status === 'failed')!;
    expect(failed).toMatchObject({ attempts: WEBHOOK_MAX_ATTEMPTS, last_error: 'HTTP 503' });

    expect((await app.inject({ method: 'POST', url: `/admin/webhook-deliveries/${failed.delivery_id}/redeliver`, headers: auth(admin) })).statusCode).toBe(200);
    expect(await deliverWebhooks(db, ok, new Date(Date.now() + 1000))).toMatchObject({ delivered: 1 });

    // Disabled: nothing more is queued for it.
    await app.inject({ method: 'POST', url: `/admin/webhooks/${created.endpoint_id}/disable`, headers: auth(admin) });
    await sell(b);
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'pending'", [created.endpoint_id]);
    expect(rows[0]!.n).toBe(0);
  });
});
