/**
 * Phase 17 API: lottery games, packs and bins; daily counts (append-only); the terminal report; and
 * the day's reconciliation against register sales and drawer payouts. Real Postgres in CI.
 */
import type { LotteryDay, LotteryPack } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { addStaff, auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let owner: string;
let cashier: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Oscar', '201-555-1200');
  b = await createTenant(db, 'Papa', '201-555-1300');
  owner = await merchantLogin(app, a.owner_phone);
  await addStaff(db, a, 'cashier', 'Maria Santos', '201-555-1201');
  cashier = await merchantLogin(app, '201-555-1201');
  await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const base = () => `/merchant/locations/${a.location_id}/lottery`;
const post = (url: string, payload: object, token = owner) => app.inject({ method: 'POST', url, headers: auth(token), payload });
const device = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (sale_id: string | null, type: string, payload: unknown, at: Date) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at.toISOString(),
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', actor_user_id: null, type, payload,
});

let fiver: string;
let packA: string;

describe('games, packs, bins', () => {
  it('set up a game, receive packs, activate one into a bin; one active pack per bin; transitions are checked', async () => {
    const g = await post(`${base()}/games`, { game_number: '1654', name: 'Lucky 7s', price_cents: 500, tickets_per_pack: 60 });
    expect(g.statusCode, g.body).toBe(201);
    fiver = g.json().game_id;
    expect((await post(`${base()}/games`, { game_number: '1654', name: 'dup', price_cents: 500, tickets_per_pack: 60 })).statusCode).toBe(400);

    packA = (await post(`${base()}/packs`, { game_id: fiver, pack_number: '0123456' })).json().pack_id;
    const packB = (await post(`${base()}/packs`, { game_id: fiver, pack_number: '0123457' })).json().pack_id;
    expect((await post(`${base()}/packs`, { game_id: fiver, pack_number: '0123456' })).statusCode).toBe(400);

    expect((await post(`/merchant/lottery/packs/${packA}/activate`, { bin: 3 })).statusCode).toBe(200);
    expect((await post(`/merchant/lottery/packs/${packB}/activate`, { bin: 3 })).statusCode).toBe(400); // bin taken
    expect((await post(`/merchant/lottery/packs/${packB}/sold_out`, {})).statusCode).toBe(400); // not active
    const state = (await app.inject({ method: 'GET', url: base(), headers: auth(owner) })).json();
    expect(state.packs.find((p: LotteryPack) => p.pack_id === packA)).toMatchObject({ status: 'active', bin: 3, start_ticket: 0, game_number: '1654', price_cents: 500 });
  });

  it('is for owners and managers, inside the merchant', async () => {
    expect((await app.inject({ method: 'GET', url: base(), headers: auth(cashier) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/merchant/locations/${b.location_id}/lottery`, headers: auth(owner) })).statusCode).toBe(404);
  });
});

describe('daily reconciliation', () => {
  it('counts give tickets sold; rung sales, terminal and drawer payouts reconcile', async () => {
    const day1 = '2026-09-22';
    const day2 = '2026-09-23';
    // Day 1: bin 3 now shows ticket 12 → 12 sold × $5 = $60.
    expect((await post(`${base()}/counts`, { business_date: day1, entries: [{ pack_id: packA, next_ticket: 12 }] })).statusCode).toBe(201);
    // Day 2: ticket 20 → 8 sold = $40. Register rang $40 of scratch-offs + $10 of Powerball; the terminal
    // says $10 online sales and $25 cashed; the drawer paid out $30 in lottery winnings.
    expect((await post(`${base()}/counts`, { business_date: day2, entries: [{ pack_id: packA, next_ticket: 20 }] })).statusCode).toBe(201);
    const at = new Date('2026-09-23T16:00:00Z');
    const sale = randomUUID();
    const session = randomUUID();
    await ingestEvents(db, device(), [
      ev(null, 'drawer.session_opened', { session_id: session, float_cents: 10_000 }, at),
      ev(sale, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }, at),
      ev(sale, 'sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Scratch-Off $5', category_id: null, qty: 8, unit_cash_price_cents: 500, unit_card_price_cents: 500, taxable: false, tax_rate_ppm: 0, min_age: 18, restriction: 'lottery' }, at),
      ev(sale, 'sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Powerball', category_id: null, qty: 5, unit_cash_price_cents: 200, unit_card_price_cents: 200, taxable: false, tax_rate_ppm: 0, min_age: 18, restriction: 'lottery' }, at),
      ev(sale, 'sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Gum', category_id: null, qty: 1, unit_cash_price_cents: 199, unit_card_price_cents: 207, taxable: false, tax_rate_ppm: 0, min_age: null }, at),
      ev(sale, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 5_199, tendered_cents: 5_199, change_cents: 0, card: null }, at),
      ev(sale, 'sale.completed', { price_mode: 'cash', subtotal_cents: 5_199, tax_cents: 0, total_cents: 5_199 }, at),
      ev(null, 'drawer.cash_movement', { movement_id: randomUUID(), session_id: session, kind: 'paid_out', amount_cents: 3_000, reason: 'Lottery payout', payee: null }, at),
    ], { receivedAt: at });
    expect((await app.inject({ method: 'PUT', url: `${base()}/terminal`, headers: auth(owner), payload: { business_date: day2, online_sales_cents: 1_000, cashes_cents: 2_500 } })).statusCode).toBe(200);

    const d = (await app.inject({ method: 'GET', url: `${base()}/day?date=${day2}`, headers: auth(owner) })).json() as LotteryDay;
    expect(d).toMatchObject({
      counted: true,
      instant: [{ game_number: '1654', tickets: 8, amount_cents: 4_000 }],
      instant_cents: 4_000,
      rung_cents: 5_000, // $40 scratch + $10 Powerball; the gum isn't lottery
      drawer_payouts_cents: 3_000,
      sales_difference_cents: 0, // 5000 − (4000 + 1000)
      payout_difference_cents: 500, // $5 more paid out than the terminal cashed
    });
    const d1 = (await app.inject({ method: 'GET', url: `${base()}/day?date=${day1}`, headers: auth(owner) })).json() as LotteryDay;
    expect(d1).toMatchObject({ instant_cents: 6_000, terminal: null, sales_difference_cents: null });
  });

  it('a count past the end of a pack is refused; sold out closes the bin; counts are append-only', async () => {
    expect((await post(`${base()}/counts`, { business_date: '2026-09-24', entries: [{ pack_id: packA, next_ticket: 61 }] })).statusCode).toBe(400);
    expect((await post(`${base()}/counts`, { business_date: '2026-09-24', entries: [{ pack_id: packA, next_ticket: 60, sold_out: true }] })).statusCode).toBe(201);
    const state = (await app.inject({ method: 'GET', url: base(), headers: auth(owner) })).json();
    expect(state.packs.some((p: LotteryPack) => p.pack_id === packA)).toBe(false); // no longer received/active
    const d = (await app.inject({ method: 'GET', url: `${base()}/day?date=2026-09-24`, headers: auth(owner) })).json() as LotteryDay;
    expect(d.instant[0]).toMatchObject({ tickets: 40, amount_cents: 20_000 }); // 20 → end of 60
    await expect(db.query('UPDATE lottery_counts SET entries = entries')).rejects.toThrow(/append-only/);
  });
});

describe('lottery export', () => {
  it('one reconciled row per day as CSV', async () => {
    const r = await app.inject({ method: 'GET', url: `${base()}/export.csv?from=2026-09-22&to=2026-09-24`, headers: auth(owner) });
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.body.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('2026-09-23,40.00,8,50.00,30.00,10.00,25.00,0.00,5.00');
  });
});
