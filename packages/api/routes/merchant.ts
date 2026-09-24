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
import { timesheet } from '../services/timeclock';
import { zReports } from '../services/eod';
import { complianceLog, salesTaxReport } from '../services/compliance-reports';
import { merchantConfig, postSupportMessage, supportThread } from '../services/merchant-config';
import { SupportMessageInput, complianceCsv, salesTaxCsv, timesheetCsv } from '@adpay/shared';
import { forbidden } from '../http/errors';

export async function merchantRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireMerchantUser);

  // Support chat with AD Pay (P12b, L40): anyone on the store's staff with app access, unless the flag is off.
  const supportOn = async (merchantId: string) => {
    if (!(await merchantConfig(db, merchantId)).flags.support_chat) throw forbidden('Support chat is not enabled for this store');
  };
  app.get('/merchant/support', async (request) => {
    const me = asMerchantUser(request);
    await supportOn(me.merchant_id);
    return { messages: await supportThread(db, me.merchant_id, 'merchant') };
  });
  app.post('/merchant/support', async (request, reply) => {
    const me = asMerchantUser(request);
    await supportOn(me.merchant_id);
    reply.status(201);
    return postSupportMessage(db, me, me.merchant_id, SupportMessageInput.parse(request.body).body, request.logContext.trace_id);
  });
  app.get('/merchant/config', async (request) => merchantConfig(db, asMerchantUser(request).merchant_id));

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

  // Time clock (P15): hours by person and day, weekly overtime, and the payroll CSV.
  const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const Range = z.object({ from: Day, to: Day }).refine((r) => r.from <= r.to && Date.parse(r.to) - Date.parse(r.from) <= 62 * 86_400_000, 'Up to 62 days, from ≤ to');
  // Sales-tax report (quarterly filing pack) and compliance log for an inspector (P16b).
  const Quarter = z.object({ from: Day, to: Day, location_id: z.uuid().optional() }).refine((r) => r.from <= r.to && Date.parse(r.to) - Date.parse(r.from) <= 93 * 86_400_000, 'Up to a quarter (93 days), from ≤ to');
  app.get('/merchant/reports/sales-tax', reports, async (request) => {
    const r = Quarter.parse(request.query);
    return salesTaxReport(db, asMerchantUser(request).merchant_id, r.from, r.to, r.location_id ?? null);
  });
  app.get('/merchant/reports/sales-tax.csv', reports, async (request, reply) => {
    const r = Quarter.parse(request.query);
    const t = await salesTaxReport(db, asMerchantUser(request).merchant_id, r.from, r.to, r.location_id ?? null);
    return reply.header('content-type', 'text/csv; charset=utf-8').send(salesTaxCsv(t));
  });
  app.get('/merchant/reports/compliance', reports, async (request) => {
    const r = Quarter.parse(request.query);
    return { entries: await complianceLog(db, asMerchantUser(request).merchant_id, r.from, r.to) };
  });
  app.get('/merchant/reports/compliance.csv', reports, async (request, reply) => {
    const r = Quarter.parse(request.query);
    return reply.header('content-type', 'text/csv; charset=utf-8').send(complianceCsv(await complianceLog(db, asMerchantUser(request).merchant_id, r.from, r.to)));
  });

  // End of day (P16): Z-reports rebuilt from the events and checked against what the register printed.
  app.get('/merchant/zreports', reports, async (request) => {
    const r = Range.parse(request.query);
    return { reports: await zReports(db, asMerchantUser(request).merchant_id, r.from, r.to) };
  });

  app.get('/merchant/timesheet', reports, async (request) => {
    const r = Range.parse(request.query);
    return timesheet(db, asMerchantUser(request).merchant_id, r.from, r.to);
  });
  app.get('/merchant/timesheet.csv', reports, async (request, reply) => {
    const r = Range.parse(request.query);
    const t = await timesheet(db, asMerchantUser(request).merchant_id, r.from, r.to);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="hours-${r.from}-to-${r.to}.csv"`).send(timesheetCsv(t));
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
