/**
 * Department ring (ADR 0046): the server takes a sale line with no item (`item_id: null`,
 * `price_source: 'department'`) and every report folds it by its department. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { salesTaxReport } from '../services/compliance-reports';
import { ingestEvents } from '../services/events';
import { createTenant, createTestApp, createTestDb, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let t: Tenant;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  t = await createTenant(db, 'Dept Ring', '201-555-2160');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('department ring on the server', () => {
  it('accepts a line with no item and counts it in the tax report by its department', async () => {
    const { rows } = await db.query<{ category_id: string }>('SELECT category_id FROM categories WHERE merchant_id = $1 LIMIT 1', [t.merchant_id]);
    const categoryId = rows[0]!.category_id;
    const sale_id = randomUUID();
    let seq = 0;
    const at = new Date().toISOString();
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
      org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id, trace_id: 't', type, payload,
    });
    const device = { kind: 'device' as const, org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: t.register_id };
    // $3.50 to the department, taxed at 6.625%: 23 tax, 373 total.
    const r = await ingestEvents(db, device, [
      ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev('sale.line_added', {
        line_id: randomUUID(), item_id: null, name: 'Grocery', category_id: categoryId, qty: 1,
        unit_cash_price_cents: 350, unit_card_price_cents: 364, taxable: true, tax_rate_ppm: 66_250, min_age: null, price_source: 'department',
      }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 373, tendered_cents: 500, change_cents: 127, card: null }),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 350, tax_cents: 23, total_cents: 373 }),
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(4);
    const day = at.slice(0, 10);
    const report = await salesTaxReport(db, t.merchant_id, day, day);
    expect(report.total).toMatchObject({ sales_count: 1, gross_sales_cents: 350, taxable_cents: 350, tax_cents: 23 });
  });
});
