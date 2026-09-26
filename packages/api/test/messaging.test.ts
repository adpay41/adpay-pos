/**
 * Phase 18b API: a receipt sent later by text or email carries the digital-receipt link (the sale's
 * token, or one minted beside a sale rung without it), goes through the message sender, is recorded
 * with the recipient masked, and is rate-limited per sale. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import type { MessageSender, OutboundMessage } from '../messaging/sender';
import { createPaymentProvider } from '../payments';
import { buildApp } from '../server';
import { createBaseLogger } from '../http/context';
import { ingestEvents } from '../services/events';
import { normalizeRecipient } from '../services/messaging';
import { auth, createTenant, createTestDb, merchantLogin, TEST_CONFIG, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let seq = 0;
const sent: OutboundMessage[] = [];
const capture: MessageSender = { name: 'capture', delivers: false, send: async (m) => (sent.push(m), { status: 'logged', provider_ref: null, error: null }) };

beforeAll(async () => {
  db = await createTestDb();
  app = await buildApp({ db, config: TEST_CONFIG, payments: createPaymentProvider('stub'), logger: createBaseLogger('silent'), messages: capture });
  a = await createTenant(db, 'Messages', '201-555-1818');
  owner = await merchantLogin(app, a.owner_phone);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function ring(token?: string) {
  const id = randomUUID();
  const ev = (type: string, payload: unknown) => ({
    event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: '2026-09-25T16:00:00.000Z',
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
  });
  await ingestEvents(db, { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id }, [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Bagel', category_id: null, qty: 1, unit_cash_price_cents: 250, unit_card_price_cents: 260, taxable: false, tax_rate_ppm: 0, min_age: null }),
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 250, tendered_cents: 250, change_cents: 0, card: null }),
    ev('sale.completed', { price_mode: 'cash', subtotal_cents: 250, tax_cents: 0, total_cents: 250, ...(token ? { receipt_token: token } : {}) }),
  ]);
  return id;
}
const send = (saleId: string, payload: object) => app.inject({ method: 'POST', url: `/merchant/sales/${saleId}/send-receipt`, headers: auth(owner), payload });

describe('send a receipt later', () => {
  it('texts the sale’s own digital-receipt link and records the message masked', async () => {
    const token = randomUUID();
    const sale = await ring(token);
    const res = await send(sale, { channel: 'sms', to: '(201) 555-0199' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'logged', delivered: false, to: '•••0199', url: `http://api.test/r/${token}` });
    expect(sent.at(-1)).toMatchObject({ channel: 'sms', to: '+12015550199', subject: null });
    expect(sent.at(-1)!.body).toBe(`Your receipt from Messages Deli $2.50: http://api.test/r/${token}`);
    const { rows } = await db.query<{ to_masked: string; status: string; provider: string }>('SELECT to_masked, status, provider FROM outbound_messages WHERE sale_id = $1', [sale]);
    expect(rows).toEqual([{ to_masked: '•••0199', status: 'logged', provider: 'capture' }]);
    const { rows: stored } = await db.query('SELECT 1 FROM outbound_messages WHERE to_masked LIKE $1', ['%5550199%']);
    expect(stored).toHaveLength(0); // the full number is never stored
  });

  it('a sale rung without a token gets a link minted beside it; the page works', async () => {
    const sale = await ring();
    const first = (await send(sale, { channel: 'email', to: 'Customer@Example.com' })).json();
    expect(sent.at(-1)).toMatchObject({ channel: 'email', to: 'customer@example.com', subject: `Your receipt from Messages Deli` });
    const again = (await send(sale, { channel: 'email', to: 'customer@example.com' })).json();
    expect(again.url).toBe(first.url); // one link per sale
    const page = await app.inject({ method: 'GET', url: new URL(first.url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Bagel');
  });

  it('refuses bad recipients, other merchants’ sales, and a sixth send in an hour', async () => {
    const sale = await ring(randomUUID());
    expect((await send(sale, { channel: 'sms', to: '555-0100' })).statusCode).toBe(400);
    expect((await send(randomUUID(), { channel: 'sms', to: '2015550199' })).statusCode).toBe(404);
    for (let i = 0; i < 5; i++) expect((await send(sale, { channel: 'sms', to: '2015550199' })).statusCode).toBe(200);
    expect((await send(sale, { channel: 'sms', to: '2015550199' })).statusCode).toBe(429);
  });

  it('normalizes US numbers and emails', () => {
    expect(normalizeRecipient('sms', '1 (201) 555-0199')).toBe('+12015550199');
    expect(normalizeRecipient('sms', '011 555 0199')).toBeNull();
    expect(normalizeRecipient('email', ' A@B.co ')).toBe('a@b.co');
    expect(normalizeRecipient('email', 'nope@')).toBeNull();
  });
});
