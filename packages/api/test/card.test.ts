/**
 * Phase 9 API: card charges and refunds through the PaymentProvider (stub), idempotent by the
 * register's ids; split sales in the ledger. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import { cardAmountFor, coverForCard, splitTotals, type SalesSummary } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let deviceA: string;
let deviceB: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
  deviceB = await pairDevice(app, db, b.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const charge = (token: string, body: object) => app.inject({ method: 'POST', url: '/device/payments/terminal-charge', headers: auth(token), payload: body });
const refund = (token: string, body: object) => app.inject({ method: 'POST', url: '/device/payments/card-refund', headers: auth(token), payload: body });

describe('terminal charge', () => {
  it('approves on the stub with brand and last four only, and a retry returns the same result without charging again', async () => {
    const body = { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 2_710 };
    const r = await charge(deviceA, body);
    expect(r.statusCode, r.body).toBe(200);
    const first = r.json();
    expect(first).toMatchObject({ status: 'approved', provider: 'stub', replayed: false });
    expect(first.last4).toMatch(/^\d{4}$/);
    expect(JSON.stringify(first)).not.toMatch(/\d{13,19}/); // nothing card-number shaped, ever

    const again = (await charge(deviceA, body)).json();
    expect(again).toMatchObject({ status: 'approved', provider_ref: first.provider_ref, replayed: true });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_attempts WHERE idempotency_key = $1', [body.tender_id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('declines the stub test amount (ending in .13) with a cashier-safe message', async () => {
    const r = (await charge(deviceA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 1_513 })).json();
    expect(r.status).toBe('declined');
    expect(r.message).toContain('.13');
  });

  it('refuses non-integer or zero amounts and anything but a device', async () => {
    expect((await charge(deviceA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 12.5 })).statusCode).toBe(400);
    expect((await charge(deviceA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 0 })).statusCode).toBe(400);
    expect((await charge(ownerA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 100 })).statusCode).toBe(403);
  });
});

describe('card refund', () => {
  it('refunds against this store’s own approved charge, never more than is left, idempotently', async () => {
    const c = (await charge(deviceA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 1_000 })).json();
    const first = { sale_id: randomUUID(), refund_id: randomUUID(), provider_ref: c.provider_ref, amount_cents: 600 };
    const r1 = await refund(deviceA, first);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().status).toBe('approved');
    expect((await refund(deviceA, first)).json().replayed).toBe(true); // replay, not a second refund

    const over = await refund(deviceA, { ...first, refund_id: randomUUID(), amount_cents: 500 }); // only 400 left
    expect(over.statusCode).toBe(400);
    expect((await refund(deviceA, { ...first, refund_id: randomUUID(), amount_cents: 400 })).json().status).toBe('approved');

    // Another merchant's register can't touch this charge.
    expect((await refund(deviceB, { ...first, refund_id: randomUUID(), amount_cents: 1 })).statusCode).toBe(404);
  });

  it('a payment id can’t be reused for a different kind of operation', async () => {
    const key = randomUUID();
    await charge(deviceA, { sale_id: randomUUID(), tender_id: key, amount_cents: 700 });
    const c = (await charge(deviceA, { sale_id: randomUUID(), tender_id: randomUUID(), amount_cents: 700 })).json();
    expect((await refund(deviceA, { sale_id: randomUUID(), refund_id: key, provider_ref: c.provider_ref, amount_cents: 100 })).statusCode).toBe(400);
  });
});

describe('split sales in the ledger', () => {
  it('cash part at the cash price, the rest at the card price; the server re-folds it with no mismatch', async () => {
    // $20.00 cash price, $20.80 card price. Customer pays $5 cash, rest on card.
    const C = 2_000;
    const K = 2_080;
    const cover = 500;
    const cardDue = cardAmountFor(C - cover, C, K); // 1500 × 2080/2000 = 1560
    expect(cardDue).toBe(1_560);
    expect(coverForCard(cardDue, C - cover, C, K)).toBe(1_500);

    const sale = randomUUID();
    const tender = randomUUID();
    const c = (await charge(deviceA, { sale_id: sale, tender_id: tender, amount_cents: cardDue })).json();
    let seq = 9000;
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++, occurred_at: new Date().toISOString(),
      org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: null, type, payload,
    });
    const totals = splitTotals({ subtotal_cents: C, tax_cents: 0, total_cents: C } as never, { subtotal_cents: K, tax_cents: 0, total_cents: K } as never, [
      { tender_type: 'cash', amount_cents: cover, covers_cash_cents: cover },
      { tender_type: 'card', amount_cents: cardDue, covers_cash_cents: 1_500 },
    ]);
    const r = await app.inject({
      method: 'POST', url: '/device/events', headers: auth(deviceA),
      payload: {
        events: [
          ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
          ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Party platter', category_id: null, qty: 1, unit_cash_price_cents: C, unit_card_price_cents: K, taxable: false, tax_rate_ppm: 0, min_age: null }),
          ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: cover, tendered_cents: cover, change_cents: 0, card: null, covers_cash_cents: cover }),
          ev('sale.card_attempt', { tender_id: tender, amount_cents: cardDue, status: 'requested', provider: 'terminal', provider_ref: null, message: null }),
          ev('sale.card_attempt', { tender_id: tender, amount_cents: cardDue, status: 'approved', provider: 'stub', provider_ref: c.provider_ref, message: null }),
          ev('sale.tender_added', { tender_id: tender, tender_type: 'card', amount_cents: cardDue, tendered_cents: null, change_cents: null, card: { provider: 'stub', provider_ref: c.provider_ref, status: 'approved', approval_code: c.approval_code, brand: c.brand, last4: c.last4 }, covers_cash_cents: 1_500 }),
          ev('sale.completed', { price_mode: 'split', ...totals }),
        ],
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rejected).toEqual([]);

    const t = (await app.inject({ method: 'GET', url: `/merchant/sales/${sale}`, headers: auth(ownerA) })).json();
    expect(t.folded).toMatchObject({ status: 'completed', price_mode: 'split', paid_cents: 2_060, remaining_cash_cents: 0, mismatch: false });
    // The terminal request and response are in the ticket's replay.
    expect(t.events.filter((e: { type: string }) => e.type === 'sale.card_attempt').map((e: { payload: { status: string } }) => e.payload.status)).toEqual(['requested', 'approved']);

    const s = (await app.inject({ method: 'GET', url: '/merchant/sales/summary?range=today', headers: auth(ownerA) })).json() as SalesSummary;
    expect(s.by_tender).toEqual(expect.arrayContaining([expect.objectContaining({ tender_type: 'card', amount_cents: 1_560 }), expect.objectContaining({ tender_type: 'cash', amount_cents: 500 })]));
  });
});
