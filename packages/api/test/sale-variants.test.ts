/**
 * Sale variants on the server, real Postgres in CI:
 * - department ring (ADR 0046): a line with no item (`item_id: null`, `price_source: 'department'`),
 *   folded by its department in every report;
 * - tax-free sale (ADR 0049): no tax, and listed as exempt in the sales-tax report.
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

describe('tax-free sale on the server (ADR 0049)', () => {
  it('the sales-tax report lists it as exempt, with no tax', async () => {
    const u = await createTenant(db, 'Tax Free', '201-555-2161');
    const sale_id = randomUUID();
    let seq = 0;
    const at = new Date().toISOString();
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
      org_id: u.org_id, merchant_id: u.merchant_id, location_id: u.location_id, register_id: u.register_id, trace_id: 't', type, payload,
    });
    const device = { kind: 'device' as const, org_id: u.org_id, merchant_id: u.merchant_id, location_id: u.location_id, register_id: u.register_id };
    const r = await ingestEvents(db, device, [
      ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Soda', category_id: null, qty: 1, unit_cash_price_cents: 299, unit_card_price_cents: 311, taxable: true, tax_rate_ppm: 66_250, min_age: null }),
      ev('sale.tax_exempted', { exempt: true, reason: 'resale', certificate: 'ST3-00417' }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 299, tendered_cents: 299, change_cents: 0, card: null }),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 299, tax_cents: 0, total_cents: 299 }),
    ]);
    expect(r.rejected).toEqual([]);
    const day = at.slice(0, 10);
    const report = await salesTaxReport(db, u.merchant_id, day, day);
    expect(report.total).toMatchObject({ sales_count: 1, gross_sales_cents: 299, taxable_cents: 0, non_taxable_cents: 299, tax_cents: 0, exempt_sales_cents: 299, exempt_count: 1 });
  });
});

describe('check and other tenders on the server (ADR 0050)', () => {
  it('the sales summary counts a check sale in gross and lists it by tender', async () => {
    const { salesSummary } = await import('../services/reports');
    const u = await createTenant(db, 'Checks', '201-555-2162');
    const sale_id = randomUUID();
    let seq = 0;
    const at = new Date().toISOString();
    const ev = (type: string, payload: unknown) => ({
      event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: at,
      org_id: u.org_id, merchant_id: u.merchant_id, location_id: u.location_id, register_id: u.register_id, trace_id: 't', type, payload,
    });
    const device = { kind: 'device' as const, org_id: u.org_id, merchant_id: u.merchant_id, location_id: u.location_id, register_id: u.register_id };
    const r = await ingestEvents(db, device, [
      ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
      ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Platter', category_id: null, qty: 1, unit_cash_price_cents: 2_000, unit_card_price_cents: 2_080, taxable: true, tax_rate_ppm: 66_250, min_age: null }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 1_000, tendered_cents: 1_000, change_cents: 0, card: null, covers_cash_cents: 1_000 }),
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'check', amount_cents: 1_133, tendered_cents: null, change_cents: null, card: null, covers_cash_cents: 1_133, reference: '1042' }),
      ev('sale.completed', { price_mode: 'cash', subtotal_cents: 2_000, tax_cents: 133, total_cents: 2_133 }),
    ]);
    expect(r.rejected).toEqual([]);
    const s = await salesSummary(db, u.merchant_id, 'today');
    expect(s.by_tender).toEqual(expect.arrayContaining([
      { tender_type: 'cash', amount_cents: 1_000, count: 1 },
      { tender_type: 'check', amount_cents: 1_133, count: 1 },
    ]));
    expect(s).toMatchObject({ sale_count: 1, gross_cents: 2_133 });
  });
});
