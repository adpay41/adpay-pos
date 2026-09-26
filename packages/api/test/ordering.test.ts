/**
 * Phase 23 API: vendors, reorder suggestions from sales by weekday and stock, a purchase order sent to
 * the rep through the message sender (then on order), received at the register against it, and the
 * discrepancy between ordered and received. Real Postgres in CI.
 */
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
let coke: string;
let vendor: string;
let seq = 0;
const sent: OutboundMessage[] = [];
const capture: MessageSender = { name: 'capture', delivers: false, send: async (m) => (sent.push(m), { status: 'logged', provider_ref: null, error: null }) };

beforeAll(async () => {
  db = await createTestDb();
  app = await buildApp({ db, config: TEST_CONFIG, payments: createPaymentProvider('stub'), logger: createBaseLogger('silent'), messages: capture });
  a = await createTenant(db, 'Orders', '201-555-2060');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  coke = (await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { name: 'Coke 20oz', category_id: null, cash_price_cents: 229, barcodes: [{ barcode: '10049000000443', pack_qty: 24 }] } })).json().item_id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const ev = (sale_id: string | null, type: string, payload: unknown, at: string) => ({
  event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
  org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
});
const dev = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });

describe('ordering', () => {
  it('a vendor with delivery days supplies the item', async () => {
    expect((await app.inject({ method: 'POST', url: '/merchant/vendors', headers: auth(owner), payload: { name: 'Coca-Cola', order_via: 'sms' } })).statusCode).toBe(400);
    const v = await app.inject({ method: 'POST', url: '/merchant/vendors', headers: auth(owner), payload: { name: 'Coca-Cola', phone: '(201) 555-0170', delivery_days: [1, 4] } });
    expect(v.statusCode).toBe(201);
    vendor = v.json().vendor_id;
    await app.inject({ method: 'PUT', url: `/merchant/items/${coke}/stock`, headers: auth(owner), payload: { track_stock: true, reorder_point: 12 } });
    await app.inject({ method: 'PUT', url: '/merchant/vendors/items', headers: auth(owner), payload: { vendor_id: vendor, item_ids: [coke] } });
    expect((await app.inject({ method: 'GET', url: '/merchant/vendors', headers: auth(owner) })).json().vendors[0]).toMatchObject({ name: 'Coca-Cola', items: 1, phone: '+12015550170' });
  });

  it('suggests enough to last until the delivery after next, in whole cases', async () => {
    // Sold 6 a day for the last 28 days; 10 on the shelf now.
    const today = new Date();
    for (let d = 1; d <= 28; d++) {
      const at = new Date(today.getTime() - d * 86_400_000).toISOString();
      const id = randomUUID();
      await ingestEvents(db, dev(), [
        ev(id, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }, at),
        ev(id, 'sale.line_added', { line_id: randomUUID(), item_id: coke, name: 'Coke 20oz', category_id: null, qty: 6, unit_cash_price_cents: 229, unit_card_price_cents: 238, taxable: false, tax_rate_ppm: 0, min_age: null }, at),
        ev(id, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 1374, tendered_cents: 1374, change_cents: 0, card: null }, at),
        ev(id, 'sale.completed', { price_mode: 'cash', subtotal_cents: 1374, tax_cents: 0, total_cents: 1374 }, at),
      ], { receivedAt: new Date(at) });
    }
    await app.inject({ method: 'POST', url: '/merchant/inventory/movements', headers: auth(owner), payload: { kind: 'count', item_id: coke, location_id: a.location_id, qty: 10 } });
    const r = (await app.inject({ method: 'GET', url: `/merchant/reorder?location_id=${a.location_id}`, headers: auth(owner) })).json();
    const s = r.vendors[0].suggestions[0];
    expect(s).toMatchObject({ item_id: coke, on_hand: 10, on_order: 0, case_qty: 24 });
    expect(s.forecast).toBeGreaterThan(0);
    expect(s.qty % 24).toBe(0);
    expect(s.qty).toBeGreaterThanOrEqual(s.forecast + 12 - 10);
  });

  it('an order goes to the rep, counts as on order, is received at the register, and shows what was short', async () => {
    const po = (await app.inject({ method: 'POST', url: '/merchant/purchase-orders', headers: auth(owner), payload: { vendor_id: vendor, location_id: a.location_id, lines: [{ item_id: coke, qty: 48 }] } })).json().po_id;
    const send = (await app.inject({ method: 'POST', url: `/merchant/purchase-orders/${po}/send`, headers: auth(owner) })).json();
    expect(send).toMatchObject({ status: 'logged', delivered: false, to: '•••0170' });
    expect(sent.at(-1)).toMatchObject({ channel: 'sms', to: '+12015550170', body: 'Order from Orders Deli for Coca-Cola:\n48 × Coke 20oz\nThank you!' });
    expect((await app.inject({ method: 'GET', url: `/merchant/reorder?location_id=${a.location_id}`, headers: auth(owner) })).json().vendors[0].suggestions[0].on_order).toBe(48);

    // The register sees the open order and receives against it: one case short.
    expect((await app.inject({ method: 'GET', url: '/device/purchase-orders', headers: auth(device) })).json().orders.map((o: { po_id: string }) => o.po_id)).toEqual([po]);
    await ingestEvents(db, dev(), [ev(null, 'inventory.received', { receipt_id: randomUUID(), item_id: coke, qty: 24, invoice_ref: 'CC-1', expires_on: null, po_id: po }, new Date().toISOString())]);
    const orders = (await app.inject({ method: 'GET', url: '/merchant/purchase-orders', headers: auth(owner) })).json().orders;
    expect(orders[0]).toMatchObject({ po_id: po, status: 'sent', discrepancies: 1, lines: [{ item_id: coke, ordered: 48, received: 24 }] });
    expect((await app.inject({ method: 'POST', url: `/merchant/purchase-orders/${po}/received`, headers: auth(owner) })).json()).toMatchObject({ status: 'received' });
    expect((await app.inject({ method: 'POST', url: `/merchant/purchase-orders/${po}/send`, headers: auth(owner) })).statusCode).toBe(400);
  });
});
