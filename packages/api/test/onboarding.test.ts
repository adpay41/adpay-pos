/**
 * Phase 12a API: the onboarding wizard (one transaction), printable install kits (fresh 14-day
 * codes; pairing makes the store live), and pricing plans with history. Real Postgres in CI.
 */
import { localDate, type CatalogSnapshot, type OnboardingResult, type OnboardingRow, type PricingPlanRow } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createAdmin, createTestApp, createTestDb, merchantLogin } from './helpers';

let db: Db;
let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  const r = await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } });
  admin = r.json().token;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

// The store's date, as the server judges plans by it (America/New_York in these fixtures).
const today = localDate(new Date(), 'America/New_York');
const wizard = (over: Record<string, unknown> = {}) => ({
  org: { name: 'Delta Group' },
  merchant: { name: 'Delta Deli', legal_name: 'Delta Deli LLC', enabled_packs: ['cstore'] },
  owner: { name: 'Dana Owner', phone: '(917) 555-0123' },
  location: { name: 'Astoria', address_line1: '1 Ditmars Blvd', city: 'Astoria', state: 'ny', postal_code: '11105', tax_rate_ppm: 88_750, compliance_template: 'NYC' },
  registers: 2,
  pricing: { kind: 'dual_pricing', dual_price_rate_ppm: 40_000, monthly_cents: 4_900, effective_from: today },
  install_date: '2026-10-05',
  hardware_note: 'T2s + A35 shipped, UPS 1Z…',
  ...over,
});
const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: auth(admin), ...(payload ? { payload } : {}) });
const get = <T>(url: string) => app.inject({ method: 'GET', url, headers: auth(admin) }).then((r) => r.json() as T);

let created: OnboardingResult;

describe('onboarding wizard', () => {
  it('creates org, merchant, owner, location with its tax template, registers, plan and pipeline row in one go', async () => {
    const r = await post('/admin/onboarding', wizard());
    expect(r.statusCode, r.body).toBe(201);
    created = r.json();
    expect(created.register_ids).toHaveLength(2);

    // The owner can sign in to the merchant app straight away.
    const owner = await merchantLogin(app, '917-555-0123');
    const snap = (await app.inject({ method: 'GET', url: '/merchant/catalog', headers: auth(owner) })).json() as CatalogSnapshot;
    expect(snap.dual_price_rate_ppm).toBe(40_000);
    // The pack's starter categories, with state age rules on tobacco and lottery.
    expect(snap.categories.find((c) => c.name === 'Tobacco')).toMatchObject({ restriction: 'tobacco' });
    // NYC template: deposit on Drinks, a bag-fee key; rates at 8.875%.
    const drinks = snap.categories.find((c) => c.name === 'Drinks')!;
    const deposit = snap.compliance!.charges.find((c) => c.kind === 'deposit')!;
    expect(deposit.category_ids).toEqual([drinks.category_id]);
    expect(snap.compliance!.charges.some((c) => c.kind === 'bag')).toBe(true);

    const pipeline = await get<{ merchants: OnboardingRow[] }>('/admin/onboarding');
    expect(pipeline.merchants.find((m) => m.merchant_id === created.merchant_id)).toMatchObject({
      status: 'setting_up', kyb_status: 'not_started', install_date: '2026-10-05', registers: 2, registers_paired: 0, org_name: 'Delta Group',
    });
    const plans = await get<{ plans: PricingPlanRow[] }>(`/admin/merchants/${created.merchant_id}/pricing`);
    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0]).toMatchObject({ current: true, plan: { kind: 'dual_pricing', dual_price_rate_ppm: 40_000 } });
  });

  it('is all or nothing: a failure part-way leaves no merchant behind', async () => {
    await db.query("UPDATE users SET phone = '+12015550777' WHERE email = 'admin@test.local'");
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM merchants')).rows[0]!.n;
    const r = await post('/admin/onboarding', wizard({ org: { name: 'Echo' }, merchant: { name: 'Echo Mart' }, owner: { name: 'X', phone: '201-555-0777' } }));
    expect(r.statusCode).toBe(400); // that phone is an AD Pay staff account
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM merchants')).rows[0]!.n).toBe(before);
    expect((await db.query("SELECT 1 FROM orgs WHERE name = 'Echo'")).rows).toHaveLength(0);
  });

  it('validates the input', async () => {
    for (const bad of [wizard({ registers: 11 }), wizard({ owner: { name: 'A', phone: '123' } }), wizard({ pricing: { kind: 'dual_pricing', dual_price_rate_ppm: 200_000, monthly_cents: 0, effective_from: today } })]) {
      expect((await post('/admin/onboarding', bad)).statusCode).toBe(400);
    }
  });
});

describe('install kit', () => {
  it('issues 14-day codes for unpaired registers; pairing one makes the store live; a new kit covers only the rest', async () => {
    const kit = (await post(`/admin/merchants/${created.merchant_id}/install-kit`)).json();
    const regs = kit.locations[0].registers as { register_id: string; code: string; expires_at: string }[];
    expect(regs).toHaveLength(2);
    expect(Date.parse(regs[0]!.expires_at) - Date.now()).toBeGreaterThan(13 * 86_400_000);

    const pair = await app.inject({ method: 'POST', url: '/auth/device/pair', payload: { setup_code: regs[0]!.code } });
    expect(pair.statusCode, pair.body).toBe(200);
    const row = (await get<{ merchants: OnboardingRow[] }>('/admin/onboarding')).merchants.find((m) => m.merchant_id === created.merchant_id)!;
    expect(row).toMatchObject({ status: 'live', registers_paired: 1 });

    const again = (await post(`/admin/merchants/${created.merchant_id}/install-kit`)).json();
    expect(again.locations[0].registers.map((r: { register_id: string }) => r.register_id)).toEqual([regs[1]!.register_id]);
    // The first kit's code for that register was replaced.
    expect((await app.inject({ method: 'POST', url: '/auth/device/pair', payload: { setup_code: regs[1]!.code } })).statusCode).toBe(400);
  });
});

describe('pricing plans', () => {
  it('keeps history; a future plan is not current yet; applying dual pricing moves the locations', async () => {
    const future = await post(`/admin/merchants/${created.merchant_id}/pricing`, {
      plan: { kind: 'ic_plus', markup_ppm: 3_000, per_txn_cents: 10, monthly_cents: 2_900, effective_from: '2099-01-01' },
    });
    expect(future.statusCode, future.body).toBe(201);
    let plans = (await get<{ plans: PricingPlanRow[] }>(`/admin/merchants/${created.merchant_id}/pricing`)).plans;
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.current)!.plan.kind).toBe('dual_pricing');

    expect((await post(`/admin/merchants/${created.merchant_id}/pricing`, { plan: { kind: 'dual_pricing', dual_price_rate_ppm: 35_000, monthly_cents: 4_900, effective_from: '2099-01-01' }, apply_to_locations: true })).statusCode).toBe(400);
    const now = await post(`/admin/merchants/${created.merchant_id}/pricing`, { plan: { kind: 'dual_pricing', dual_price_rate_ppm: 35_000, monthly_cents: 3_900, effective_from: today, note: 'first-year promo' }, apply_to_locations: true });
    expect(now.statusCode, now.body).toBe(201);
    plans = (await get<{ plans: PricingPlanRow[] }>(`/admin/merchants/${created.merchant_id}/pricing`)).plans;
    expect(plans.find((p) => p.current)!.plan).toMatchObject({ dual_price_rate_ppm: 35_000, note: 'first-year promo' });
    const { rows } = await db.query<{ r: number }>('SELECT dual_price_rate_ppm AS r FROM locations WHERE merchant_id = $1', [created.merchant_id]);
    expect(rows.map((x) => x.r)).toEqual([35_000]);

    // History can't be rewritten.
    await expect(db.query('UPDATE merchant_pricing_plans SET effective_from = effective_from WHERE merchant_id = $1', [created.merchant_id])).rejects.toThrow(/append-only/);
  });

  it('is admin only', async () => {
    const owner = await merchantLogin(app, '917-555-0123');
    expect((await app.inject({ method: 'GET', url: `/admin/merchants/${created.merchant_id}/pricing`, headers: auth(owner) })).statusCode).toBe(403);
  });
});
