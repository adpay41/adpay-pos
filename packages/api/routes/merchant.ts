/**
 * Merchant-user routes. The merchant scope comes only from the credential: there is no merchant id
 * in any path or body here, so a merchant user cannot address another merchant's data at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asMerchantUser, requireMerchantUser, requirePermission } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import { getSaleTimeline } from '../services/events';
import { tenancyTree } from '../services/onboarding';
import { cashReport } from '../services/cash';
import { recentSales, salesCompare, salesSummary } from '../services/reports';

export async function merchantRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireMerchantUser);

  app.get('/merchant/overview', async (request) => {
    const me = asMerchantUser(request);
    return tenancyTree(db, me.merchant_id);
  });

  // Sales figures are for people the owner lets see them (`reports.view`; cashiers can't by default).
  const reports = { preHandler: requirePermission('reports.view') };

  app.get('/merchant/sales/summary', reports, async (request) => {
    const me = asMerchantUser(request);
    const q = z
      .object({ range: z.enum(['today', 'week', 'month']).default('today'), location_id: z.uuid().optional() })
      .parse(request.query);
    return salesSummary(db, me.merchant_id, q.range, q.location_id ?? null);
  });

  // Today vs yesterday vs same day last week, by hour, cut at the same time of day (P11, Bible L31).
  app.get('/merchant/sales/compare', reports, async (request) => {
    const me = asMerchantUser(request);
    const q = z.object({ location_id: z.uuid().optional() }).parse(request.query);
    return salesCompare(db, me.merchant_id, q.location_id ?? null);
  });

  app.get('/merchant/sales', reports, async (request) => {
    const me = asMerchantUser(request);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return { sales: await recentSales(db, me.merchant_id, limit) };
  });

  // Cash drawer sessions: float, drops, paid-outs, blind counts, over/short by cashier (P6).
  app.get('/merchant/cash', reports, async (request) => {
    const me = asMerchantUser(request);
    const q = z.object({ range: z.enum(['today', 'week', 'month']).default('today'), location_id: z.uuid().optional() }).parse(request.query);
    return cashReport(db, me.merchant_id, q.range, q.location_id ?? null);
  });

  app.get('/merchant/sales/:saleId', reports, async (request) => {
    const me = asMerchantUser(request);
    const { saleId } = z.object({ saleId: z.uuid() }).parse(request.params);
    return getSaleTimeline(db, saleId, me.merchant_id);
  });

  app.get('/merchant/catalog', async (request) => {
    const me = asMerchantUser(request);
    const { location_id } = z.object({ location_id: z.uuid().optional() }).parse(request.query);
    // A location id from the query is honoured only if it belongs to this merchant (the snapshot
    // query filters on both), otherwise it is a 404.
    return getCatalogSnapshot(db, me.merchant_id, location_id ?? (await defaultLocationId(db, me.merchant_id)));
  });
}
