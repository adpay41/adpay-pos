/**
 * Phase 19a API: loyalty by phone. The register snapshot carries the program and salt; sales naming
 * a customer build the customer list; the balance is folded from their sales (a reward spends it);
 * an opt-in is accepted only for the number behind the ref; promos reach opted-in customers once a
 * week with STOP; "text me my receipt" from the register. Real Postgres in CI.
 */
import { customerRef, type CatalogSnapshot } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { createBaseLogger } from '../http/context';
import type { MessageSender, OutboundMessage } from '../messaging/sender';
import { createPaymentProvider } from '../payments';
import { buildApp } from '../server';
import { ingestEvents } from '../services/events';
import { auth, createTenant, createTestDb, merchantLogin, pairDevice, TEST_CONFIG, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let device: string;
let salt: string;
let coffee: string;
let seq = 0;
const sent: OutboundMessage[] = [];
const capture: MessageSender = { name: 'capture', delivers: false, send: async (m) => (sent.push(m), { status: 'logged', provider_ref: null, error: null }) };

beforeAll(async () => {
  db = await createTestDb();
  app = await buildApp({ db, config: TEST_CONFIG, payments: createPaymentProvider('stub'), logger: createBaseLogger('silent'), messages: capture });
  a = await createTenant(db, 'Loyal', '201-555-1919');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  const { rows } = await db.query<{ category_id: string }>(
    `INSERT INTO categories (org_id, merchant_id, name, sort, taxable) VALUES ($1, $2, 'Coffee', 1, true) RETURNING category_id`,
    [a.org_id, a.merchant_id],
  );
  coffee = rows[0]!.category_id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
const PHONE = '+12015550142';

async function ring(ref: string, opts: { redeem?: number; name?: string; cat?: string | null } = {}) {
  const id = randomUUID();
  const line = randomUUID();
  const ev = (type: string, payload: unknown) => ({
    event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: new Date(Date.UTC(2026, 8, 20, 12, 0, seq)).toISOString(),
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
  });
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', {
      line_id: line, item_id: randomUUID(), name: opts.name ?? 'Coffee', category_id: opts.cat === undefined ? coffee : opts.cat, qty: 1,
      unit_cash_price_cents: 275, unit_card_price_cents: 286, taxable: false, tax_rate_ppm: 0, min_age: null,
    }),
    ev('sale.customer_identified', { customer_ref: ref, last4: '0142', marketing_opt_in: false }),
  ];
  let total = 275;
  if (opts.redeem) {
    events.push(
      ev('sale.line_discounted', { line_id: line, cash_discount_cents: 275, card_discount_cents: 286, reason: 'Loyalty reward' }),
      ev('sale.loyalty_redeemed', { customer_ref: ref, cost: opts.redeem, discount_cents: 275 }),
    );
    total = 0;
  }
  events.push(
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: total, tendered_cents: total, change_cents: 0, card: null }),
    ev('sale.completed', { price_mode: 'cash', subtotal_cents: total, tax_cents: 0, total_cents: total }),
  );
  await ingestEvents(db, { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id }, events);
  return id;
}

describe('loyalty program', () => {
  it('the owner sets it up; the register snapshot carries it with the salt; apps never see the salt', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/merchant/loyalty', headers: auth(owner),
      payload: { enabled: true, kind: 'visits', visits_needed: 3, qualifying_category_id: coffee, reward: { kind: 'free_item', max_cents: 300 } },
    });
    expect(put.statusCode).toBe(200);
    const snap = await snapshot();
    expect(snap.loyalty?.settings).toMatchObject({ enabled: true, visits_needed: 3, qualifying_category_id: coffee });
    expect(snap.loyalty?.salt).toMatch(/^[0-9a-f]{64}$/);
    salt = snap.loyalty!.salt;
    const forApps = (await app.inject({ method: 'GET', url: '/merchant/catalog', headers: auth(owner) })).body;
    expect(forApps).not.toContain(salt);
    expect((await app.inject({ method: 'PUT', url: '/merchant/loyalty', headers: auth(owner), payload: { qualifying_category_id: randomUUID() } })).statusCode).toBe(400);
  });

  it('visits build up from sales; a reward spends them; a non-qualifying sale earns nothing', async () => {
    const ref = customerRef(salt, PHONE);
    for (let i = 0; i < 3; i++) await ring(ref);
    await ring(ref, { name: 'Bagel', cat: null });
    const status = async () => (await app.inject({ method: 'GET', url: `/device/loyalty/${ref}`, headers: auth(device) })).json();
    expect(await status()).toMatchObject({ enabled: true, balance: 3, needed: 3, rewards_available: 1, visits: 4 });
    await ring(ref, { redeem: 3 });
    expect(await status()).toMatchObject({ balance: 1, rewards_available: 0, to_next: 2, visits: 5 });
    const list = (await app.inject({ method: 'GET', url: '/merchant/customers', headers: auth(owner) })).json();
    expect(list.customers).toEqual([expect.objectContaining({ customer_ref: ref, last4: '0142', visits: 5, spent_cents: 4 * 275, texts: 'no' })]);
    // The phone number is nowhere in the ledger.
    const { rows } = await db.query(`SELECT 1 FROM sale_events WHERE payload::text LIKE '%5550142%'`);
    expect(rows).toHaveLength(0);
  });
});

describe('texts', () => {
  it('an opt-in is stored only for the number behind the ref, with the consent text', async () => {
    const ref = customerRef(salt, PHONE);
    const optIn = (phone: string) => app.inject({ method: 'POST', url: '/device/customers/opt-in', headers: auth(device), payload: { phone, customer_ref: ref, consent_version: 'v1' } });
    expect((await optIn('2015550143')).statusCode).toBe(400);
    expect((await optIn('(201) 555-0142')).statusCode).toBe(200);
    const { rows } = await db.query<{ phone_e164: string; consent_text: string }>('SELECT phone_e164, consent_text FROM customers WHERE customer_ref = $1', [ref]);
    expect(rows[0]).toMatchObject({ phone_e164: PHONE });
    expect(rows[0]!.consent_text).toContain('Reply STOP');
  });

  it('a promo reaches opted-in customers once a week, with STOP; an opt-out removes the number', async () => {
    await ring(customerRef(salt, '+12015550177')); // a customer who never opted in
    const send = () =>
      app.inject({ method: 'POST', url: '/merchant/customers/promo', headers: auth(owner), payload: { message: 'Free coffee with any sandwich today!', top: 100 } });
    expect((await send()).json()).toMatchObject({ recipients: 1, skipped_recent: 0, status: 'logged', delivered: false });
    expect(sent.at(-1)).toMatchObject({ channel: 'sms', to: PHONE, body: 'Loyal Deli: Free coffee with any sandwich today! Reply STOP to opt out.' });
    expect((await send()).json()).toMatchObject({ recipients: 0, skipped_recent: 1 });

    const ref = customerRef(salt, PHONE);
    expect((await app.inject({ method: 'POST', url: `/merchant/customers/${ref}/opt-out`, headers: auth(owner) })).statusCode).toBe(200);
    const { rows } = await db.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM customers WHERE customer_ref = $1', [ref]);
    expect(rows[0]!.phone_e164).toBeNull();
    const list = (await app.inject({ method: 'GET', url: '/merchant/customers', headers: auth(owner) })).json();
    expect(list.customers.find((c: { customer_ref: string }) => c.customer_ref === ref).texts).toBe('opted_out');
  });

  it('“text me my receipt” from the register sends the digital-receipt link', async () => {
    const token = randomUUID();
    const res = await app.inject({ method: 'POST', url: '/device/receipts/text', headers: auth(device), payload: { sale_id: randomUUID(), receipt_token: token, phone: '201 555 0188' } });
    expect(res.json()).toMatchObject({ status: 'logged', delivered: false, to: '•••0188' });
    expect(sent.at(-1)).toMatchObject({ to: '+12015550188', body: `Your receipt from Loyal Deli: http://api.test/r/${token}` });
  });
});
