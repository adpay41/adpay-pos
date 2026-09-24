/**
 * Admin (AD Pay staff) routes. Cross-tenant by role; every write is audited.
 */
import { ComplianceSettingsInput, localDate, taxRateOn, ProcessorCostInput, StatementInput, FeatureFlagOverridesInput, KYB_STATUSES, ONBOARDING_STATUSES, OnboardingInput, PACK_IDS, PricingPlanInput, SupportMessageInput } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asAdmin, requireAdmin } from '../http/auth-hooks';
import { notFound } from '../http/errors';
import type { AppDeps } from '../server';
import { audit } from '../services/audit';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import { getSaleTimeline } from '../services/events';
import {
  createLocation,
  createMerchant,
  createOrg,
  createRegister,
  issueSetupCode,
  tenancyTree,
} from '../services/onboarding';
import { cashReport } from '../services/cash';
import { timesheet } from '../services/timeclock';
import { zReports } from '../services/eod';
import { complianceLog, salesTaxReport } from '../services/compliance-reports';
import { kpis, listAnalyses, residualReport, saveAnalysis, setProcessorCost } from '../services/money';
import { merchantConfig, postSupportMessage, setFeatureFlags, setPacks, supportInbox, supportThread } from '../services/merchant-config';
import { addPricingPlan, installKit, onboardMerchant, onboardingList, pricingPlans, updateOnboarding } from '../services/merchant-setup';
import { recentSales, salesSummary } from '../services/reports';

const Ppm = z.int().min(0).max(1_000_000);
const RangeQuery = z.object({ range: z.enum(['today', 'week', 'month']).default('today') });

export async function adminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/tenancy', async () => tenancyTree(db));

  // Onboarding wizard (P12a, ADR 0020): one call, one transaction.
  app.post('/admin/onboarding', async (request, reply) => {
    reply.status(201);
    return onboardMerchant(db, asAdmin(request), OnboardingInput.parse(request.body), request.logContext.trace_id);
  });
  app.get('/admin/onboarding', async () => ({ merchants: await onboardingList(db) }));
  app.patch('/admin/onboarding/:merchantId', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const body = z
      .strictObject({
        status: z.enum(ONBOARDING_STATUSES).optional(),
        kyb_status: z.enum(KYB_STATUSES).optional(),
        install_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        hardware_note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(request.body);
    await updateOnboarding(db, asAdmin(request), merchantId, body, request.logContext.trace_id);
    return { ok: true };
  });
  // Printable install kit: fresh 14-day setup codes for every unpaired register (L43).
  app.post('/admin/merchants/:merchantId/install-kit', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    return installKit(db, asAdmin(request), merchantId, request.logContext.trace_id);
  });
  // Feature flags and vertical packs per merchant (P12b, L52).
  const MerchantParams = z.object({ merchantId: z.uuid() });
  app.get('/admin/merchants/:merchantId/config', async (request) => merchantConfig(db, MerchantParams.parse(request.params).merchantId));
  app.put('/admin/merchants/:merchantId/flags', async (request) => {
    const { merchantId } = MerchantParams.parse(request.params);
    return setFeatureFlags(db, asAdmin(request), merchantId, FeatureFlagOverridesInput.parse(request.body), request.logContext.trace_id);
  });
  app.put('/admin/merchants/:merchantId/packs', async (request) => {
    const { merchantId } = MerchantParams.parse(request.params);
    const { enabled_packs } = z.strictObject({ enabled_packs: z.array(z.enum(PACK_IDS)).min(1).refine((p) => new Set(p).size === p.length, 'Each pack once') }).parse(request.body);
    return setPacks(db, asAdmin(request), merchantId, enabled_packs, request.logContext.trace_id);
  });

  // Support chat (P12b, L40): AD Pay's inbox and one conversation per merchant.
  app.get('/admin/support', async () => ({ conversations: await supportInbox(db) }));
  app.get('/admin/support/:merchantId', async (request) => ({ messages: await supportThread(db, MerchantParams.parse(request.params).merchantId, 'admin') }));
  app.post('/admin/support/:merchantId', async (request, reply) => {
    const { merchantId } = MerchantParams.parse(request.params);
    reply.status(201);
    return postSupportMessage(db, asAdmin(request), merchantId, SupportMessageInput.parse(request.body).body, request.logContext.trace_id);
  });

  // AD Pay's own numbers (P13, ADR 0022): statement analyzer, residuals, KPIs.
  app.get('/admin/analyzer', async () => ({ analyses: await listAnalyses(db) }));
  app.get('/admin/analyzer/:analysisId', async (request) => {
    const { analysisId } = z.object({ analysisId: z.uuid() }).parse(request.params);
    const [a] = await listAnalyses(db, analysisId);
    if (!a) throw notFound('No such analysis');
    return a;
  });
  app.post('/admin/analyzer', async (request, reply) => {
    reply.status(201);
    return saveAnalysis(db, asAdmin(request), StatementInput.parse(request.body), request.logContext.trace_id);
  });
  app.get('/admin/residuals', async (request) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
    return { month, rows: await residualReport(db, month) };
  });
  app.put('/admin/merchants/:merchantId/processor-cost', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    await setProcessorCost(db, asAdmin(request), merchantId, ProcessorCostInput.parse(request.body), request.logContext.trace_id);
    return { ok: true };
  });
  app.get('/admin/kpis', async () => kpis(db));

  // Tax tables across every location (P16b): the rate in force today, dated changes ahead, charges.
  app.get('/admin/tax-tables', async () => {
    const { rows } = await db.query<{ merchant_id: string; merchant_name: string; location_id: string; location_name: string; state: string | null; timezone: string; tax_rate_ppm: number; compliance: unknown }>(
      `SELECT m.merchant_id, m.name AS merchant_name, l.location_id, l.name AS location_name, l.state, l.timezone, l.tax_rate_ppm, l.compliance
         FROM locations l JOIN merchants m ON m.merchant_id = l.merchant_id ORDER BY l.state NULLS LAST, m.name, l.name`,
    );
    return {
      locations: rows.map((r) => {
        const c = ComplianceSettingsInput.safeParse(r.compliance ?? {}).data ?? { tax_rates: [], charges: [], age_rules: {} };
        const today = localDate(new Date(), r.timezone);
        return {
          merchant_id: r.merchant_id,
          merchant_name: r.merchant_name,
          location_id: r.location_id,
          location_name: r.location_name,
          state: r.state,
          standard_rate_ppm: taxRateOn(c.tax_rates, 'standard', today, r.tax_rate_ppm),
          upcoming: c.tax_rates.filter((t) => t.effective_from > today).map((t) => ({ tax_class: t.tax_class, rate_ppm: t.rate_ppm, effective_from: t.effective_from })),
          classes: [...new Set(c.tax_rates.map((t) => t.tax_class))],
          charges: c.charges.map((x) => ({ kind: x.kind, label: x.label, amount_cents: x.amount_cents, rate_ppm: x.rate_ppm, categories: x.category_ids.length })),
          age_overrides: c.age_rules,
        };
      }),
    };
  });
  app.get('/admin/merchants/:merchantId/reports/sales-tax', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const r = z.object({ from: Day, to: Day, location_id: z.uuid().optional() }).parse(request.query);
    return salesTaxReport(db, merchantId, r.from, r.to, r.location_id ?? null);
  });
  app.get('/admin/merchants/:merchantId/reports/compliance', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const r = z.object({ from: Day, to: Day }).parse(request.query);
    return { entries: await complianceLog(db, merchantId, r.from, r.to) };
  });
  app.get('/admin/merchants/:merchantId/zreports', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const r = z.object({ from: Day, to: Day }).parse(request.query);
    return { reports: await zReports(db, merchantId, r.from, r.to) };
  });
  app.get('/admin/merchants/:merchantId/timesheet', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    const r = z.object({ from: Day, to: Day }).parse(request.query);
    return timesheet(db, merchantId, r.from, r.to);
  });

  // Pricing plans with history (L51).
  app.get('/admin/merchants/:merchantId/pricing', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    return { plans: await pricingPlans(db, merchantId) };
  });
  app.post('/admin/merchants/:merchantId/pricing', async (request, reply) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const body = z.strictObject({ plan: PricingPlanInput, apply_to_locations: z.boolean().default(false) }).parse(request.body);
    reply.status(201);
    return addPricingPlan(db, asAdmin(request), merchantId, body.plan, body.apply_to_locations, request.logContext.trace_id);
  });

  app.post('/admin/orgs', async (request) => {
    const admin = asAdmin(request);
    const body = z.object({ name: z.string().min(1).max(200) }).parse(request.body);
    const org = await createOrg(db, body.name);
    await audit(db, { actor: admin, action: 'org.created', tenancy: org, target: org.org_id, details: body, trace_id: request.logContext.trace_id });
    return org;
  });

  app.post('/admin/merchants', async (request) => {
    const admin = asAdmin(request);
    const body = z
      .object({
        org_id: z.uuid(),
        name: z.string().min(1).max(200),
        legal_name: z.string().max(200).nullish(),
        enabled_packs: z.array(z.enum(PACK_IDS)).min(1).default(['cstore']),
      })
      .parse(request.body);
    const m = await db.tx((q) => createMerchant(q, body));
    await audit(db, { actor: admin, action: 'merchant.created', tenancy: m, target: m.merchant_id, details: body, trace_id: request.logContext.trace_id });
    return m;
  });

  app.post('/admin/locations', async (request) => {
    const admin = asAdmin(request);
    const body = z
      .object({
        merchant_id: z.uuid(),
        name: z.string().min(1).max(200),
        address_line1: z.string().max(200).nullish(),
        city: z.string().max(100).nullish(),
        state: z.string().length(2).nullish(),
        postal_code: z.string().max(10).nullish(),
        timezone: z.string().default('America/New_York'),
        tax_rate_ppm: Ppm,
        dual_price_rate_ppm: Ppm.default(0),
      })
      .parse(request.body);
    const loc = await createLocation(db, body);
    await audit(db, { actor: admin, action: 'location.created', tenancy: loc, target: loc.location_id, details: body, trace_id: request.logContext.trace_id });
    return loc;
  });

  app.post('/admin/registers', async (request) => {
    const admin = asAdmin(request);
    const body = z.object({ location_id: z.uuid(), name: z.string().min(1).max(100) }).parse(request.body);
    const reg = await createRegister(db, body);
    await audit(db, { actor: admin, action: 'register.created', tenancy: reg, target: reg.register_id, details: body, trace_id: request.logContext.trace_id });
    return reg;
  });

  app.post('/admin/registers/:registerId/setup-code', async (request) => {
    const admin = asAdmin(request);
    const { registerId } = z.object({ registerId: z.uuid() }).parse(request.params);
    const result = await db.tx((q) => issueSetupCode(q, registerId, admin.user_id));
    await audit(db, {
      actor: admin,
      action: 'register.setup_code_issued',
      tenancy: { register_id: registerId },
      target: registerId,
      details: { expires_at: result.expires_at },
      trace_id: request.logContext.trace_id,
    });
    return result;
  });

  app.get('/admin/merchants/:merchantId/catalog', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const { location_id } = z.object({ location_id: z.uuid().optional() }).parse(request.query);
    return getCatalogSnapshot(db, merchantId, location_id ?? (await defaultLocationId(db, merchantId)));
  });

  app.get('/admin/merchants/:merchantId/sales/summary', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const { range } = RangeQuery.parse(request.query);
    return salesSummary(db, merchantId, range);
  });

  app.get('/admin/merchants/:merchantId/cash', async (request) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(request.params);
    const { range } = RangeQuery.parse(request.query);
    return cashReport(db, merchantId, range);
  });

  app.get('/admin/sales', async (request) => {
    const { merchant_id, limit } = z
      .object({ merchant_id: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return { sales: await recentSales(db, merchant_id ?? null, limit) };
  });

  app.get('/admin/sales/:saleId', async (request) => {
    const { saleId } = z.object({ saleId: z.uuid() }).parse(request.params);
    return getSaleTimeline(db, saleId, null);
  });

  app.get('/admin/audit', async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const { rows } = await db.query(
      `SELECT a.audit_id, a.at, a.actor_kind, u.email AS actor_email, a.action, a.target, a.details,
              a.org_id, a.merchant_id, a.location_id, a.register_id, a.trace_id
         FROM audit_log a LEFT JOIN users u ON u.user_id = a.actor_user_id
        ORDER BY a.at DESC LIMIT $1`,
      [limit],
    );
    return { entries: rows };
  });
}
