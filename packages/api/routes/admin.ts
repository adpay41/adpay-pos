/**
 * Admin (AD Pay staff) routes. Cross-tenant by role; every write is audited.
 */
import { PACK_IDS } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asAdmin, requireAdmin } from '../http/auth-hooks';
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
import { recentSales, salesSummary } from '../services/reports';

const Ppm = z.int().min(0).max(1_000_000);
const RangeQuery = z.object({ range: z.enum(['today', 'week', 'month']).default('today') });

export async function adminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/tenancy', async () => tenancyTree(db));

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
