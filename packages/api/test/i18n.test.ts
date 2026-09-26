/**
 * Phase 18 API: languages in the register snapshot (a draft is never offered), translations
 * management (status with reviewer, overrides with placeholder check, catalog bump), and the public
 * digital receipt page by token. Real Postgres in CI.
 */
import { CUSTOMER_KEYS, type CatalogSnapshot } from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let device: string;
let admin: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Eighteen', '201-555-1800');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
const setReceipt = (body: object) =>
  app.inject({ method: 'PUT', url: `/merchant/locations/${a.location_id}/receipt`, headers: auth(owner), payload: body });

describe('languages in the snapshot', () => {
  it('defaults to English and Spanish; a draft language is never offered', async () => {
    expect((await snapshot()).i18n).toMatchObject({ offered: ['en', 'es'], default: 'en' });
    expect((await setReceipt({ languages: ['es', 'zh', 'gu'], default_language: 'gu' })).statusCode).toBe(200);
    // Gujarati is a draft until reviewed: dropped, and the default falls back to English.
    expect((await snapshot()).i18n).toMatchObject({ offered: ['en', 'es', 'zh'], default: 'en' });
  });

  it('marking a language reviewed records who, offers it, and refreshes registers', async () => {
    const before = (await snapshot()).catalog_version;
    const res = await app.inject({ method: 'PUT', url: '/admin/translations/gu/status', headers: auth(admin), payload: { status: 'reviewed', note: 'Checked by a fluent speaker' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().languages.find((l: { code: string }) => l.code === 'gu')).toMatchObject({ status: 'reviewed', reviewed_by: 'Test Admin', translated: CUSTOMER_KEYS.length, total: CUSTOMER_KEYS.length, locations_asking: 1 });
    const snap = await snapshot();
    expect(snap.catalog_version).toBeGreaterThan(before);
    expect(snap.i18n).toMatchObject({ offered: ['en', 'es', 'zh', 'gu'], default: 'gu' });
  });

  it('English cannot be taken away', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/translations/en/status', headers: auth(admin), payload: { status: 'draft' } })).statusCode).toBe(400);
  });
});

describe('translation overrides', () => {
  it('an override reaches registers that offer the language; placeholders must survive', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/admin/translations/es/strings', headers: auth(admin), payload: { key: 'r_each', text: '@ cada uno' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('{price}');

    const ok = await app.inject({ method: 'PUT', url: '/admin/translations/es/strings', headers: auth(admin), payload: { key: 'thanks', text: '¡Mil gracias!' } });
    expect(ok.json().strings.find((s: { key: string }) => s.key === 'thanks')).toMatchObject({ english: 'Thank you!', built_in: '¡Gracias!', override: '¡Mil gracias!' });
    expect((await snapshot()).i18n?.overrides).toEqual({ es: { thanks: '¡Mil gracias!' } });

    await app.inject({ method: 'PUT', url: '/admin/translations/es/strings', headers: auth(admin), payload: { key: 'thanks', text: null } });
    expect((await snapshot()).i18n?.overrides).toEqual({});
  });

  it('a cashier string (its English is the key) can be corrected; an unknown key is refused', async () => {
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/admin/translations/ko/strings', headers: auth(admin), payload });
    const ok = await put({ key: 'Void ticket', text: '티켓 취소' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().strings.find((s: { key: string }) => s.key === 'Void ticket')).toMatchObject({ area: 'cashier', english: 'Void ticket', built_in: null, override: '티켓 취소' });
    expect((await snapshot()).i18n).toMatchObject({ cashier: ['en', 'es', 'zh', 'ko', 'ar', 'hi', 'gu'], overrides: { ko: { 'Void ticket': '티켓 취소' } } });
    expect((await put({ key: 'Not a string we have', text: 'x' })).statusCode).toBe(400);
    await put({ key: 'Void ticket', text: null });
  });

  it('is admin-only', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/translations', headers: auth(owner) })).statusCode).toBe(403);
  });
});

describe('digital receipt page', () => {
  const ev = (sale_id: string, type: string, payload: unknown) => ({
    event_id: randomUUID(), schema_version: 1, sale_id, device_seq: seq++, occurred_at: '2026-09-25T16:00:00.000Z',
    org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't', type, payload,
  });
  async function ring(language: string, token: string) {
    const id = randomUUID();
    await ingestEvents(
      db,
      { kind: 'device', org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id },
      [
        ev(id, 'sale.opened', { cashier_user_id: null, catalog_version: 1 }),
        ev(id, 'sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Hot Coffee — Large', category_id: null, qty: 2, unit_cash_price_cents: 275, unit_card_price_cents: 286, taxable: true, tax_rate_ppm: 66_250, min_age: null }),
        ev(id, 'sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: 586, tendered_cents: 1000, change_cents: 414, card: null }),
        ev(id, 'sale.completed', { price_mode: 'cash', subtotal_cents: 550, tax_cents: 36, total_cents: 586, language, receipt_token: token }),
      ],
      { receivedAt: new Date('2026-09-25T16:00:01Z') },
    );
  }

  it('shows the receipt as printed, in the customer language, to anyone with the link', async () => {
    const token = randomUUID();
    await ring('zh', token);
    const res = await app.inject({ method: 'GET', url: `/r/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('lang="zh"');
    expect(res.body).toMatch(/总计\s+\$5\.86/);
    expect(res.body).toMatch(/找零\s+\$4\.14/);
    expect(res.body).toContain('Hot Coffee — Large');
    expect(res.body).not.toContain('<script');
  });

  it('Arabic pages are right-to-left', async () => {
    const token = randomUUID();
    await ring('ar', token);
    expect((await app.inject({ method: 'GET', url: `/r/${token}` })).body).toContain('dir="rtl"');
  });

  it('an unknown or not-yet-synced token gets a friendly page that checks again, not an error', async () => {
    const res = await app.inject({ method: 'GET', url: `/r/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('on its way');
    expect(res.body).toContain('http-equiv="refresh"');
    expect((await app.inject({ method: 'GET', url: '/r/not-a-token' })).statusCode).toBe(404);
  });
});
