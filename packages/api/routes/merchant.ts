/**
 * Merchant-user routes. The merchant scope comes only from the credential: there is no merchant id
 * in any path or body here, so a merchant user cannot address another merchant's data at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asMerchantUser, requireMerchantUser, requirePermission } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { createMessageSender } from '../messaging/sender';
import { sendReceipt } from '../services/messaging';
import { cashierPerformance, dailyJournal } from '../services/performance';
import { rollup } from '../services/rollup';
import { listDocuments, pgDocumentStore, removeDocument, uploadDocument, validateDocument } from '../services/documents';
import { checklistReport, getChecklists, setChecklists } from '../services/checklists';
import { upcLookup } from '../services/upc-library';
import { addTicketNote, createTicket, listHardware, listTickets, ticketDetail } from '../services/support';
import { profitReport } from '../services/price-tools';
import { customerList, customerStatus, loyaltyConfig, optOut, sendPromo, setLoyaltySettings } from '../services/loyalty';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import { getSaleTimeline } from '../services/events';
import { tenancyTree } from '../services/onboarding';
import { cashReport } from '../services/cash';
import { recentSales, salesCompare, salesSummary } from '../services/reports';
import { timesheet } from '../services/timeclock';
import { zReports } from '../services/eod';
import { complianceLog, salesTaxReport } from '../services/compliance-reports';
import { merchantConfig, postSupportMessage, supportThread } from '../services/merchant-config';
import { ChecklistsInput, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, DocumentMetaInput, MerchantTicketInput, CustomerRefSchema, journalCsv, LoyaltySettingsInput, SupportMessageInput, complianceCsv, salesTaxCsv, timesheetCsv } from '@adpay/shared';
import { badRequest, forbidden, notFound } from '../http/errors';

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

  // Cashier performance, the accountant's daily journal, and the multi-store roll-up (P19b).
  app.get('/merchant/reports/cashiers', reports, async (request) => {
    const r = Range.parse(request.query);
    return cashierPerformance(db, asMerchantUser(request).merchant_id, r.from, r.to);
  });
  // Profit by category and item (P20b): each unit at the cost in force when it was sold.
  app.get('/merchant/reports/profit', reports, async (request) => {
    const r = Quarter.parse(request.query);
    return profitReport(db, asMerchantUser(request).merchant_id, r.from, r.to);
  });
  app.get('/merchant/reports/journal', reports, async (request) => {
    const r = Quarter.parse(request.query);
    return { from: r.from, to: r.to, days: await dailyJournal(db, asMerchantUser(request).merchant_id, r.from, r.to) };
  });
  app.get('/merchant/reports/journal.csv', reports, async (request, reply) => {
    const r = Quarter.parse(request.query);
    const days = await dailyJournal(db, asMerchantUser(request).merchant_id, r.from, r.to);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="journal-${r.from}-to-${r.to}.csv"`).send(journalCsv(days));
  });
  app.get('/merchant/rollup', async (request) => {
    const { range } = z.object({ range: z.enum(['today', 'week', 'month']).default('today') }).parse(request.query);
    return rollup(db, asMerchantUser(request).user_id, range);
  });

  app.get('/merchant/timesheet', reports, async (request) => {
    const r = Range.parse(request.query);
    return timesheet(db, asMerchantUser(request).merchant_id, r.from, r.to);
  });
  // The global UPC library (P25c): a suggestion when adding an item by barcode.
  app.get('/merchant/upc/:code', { preHandler: requirePermission('catalog.edit') }, async (request) => {
    const { code } = z.object({ code: z.string().min(1).max(20) }).parse(request.params);
    return { suggestion: await upcLookup(db, code) };
  });

  // Opening and closing checklists (P24c): the lists (config) and what was ticked (events).
  app.get('/merchant/checklists', async (request) => getChecklists(db, asMerchantUser(request).merchant_id));
  app.put('/merchant/checklists', { preHandler: requirePermission('staff.manage') }, async (request) =>
    setChecklists(db, asMerchantUser(request), ChecklistsInput.parse(request.body), request.logContext.trace_id),
  );
  app.get('/merchant/checklists/report', reports, async (request) => {
    const r = Range.parse(request.query);
    return checklistReport(db, asMerchantUser(request).merchant_id, r.from, r.to);
  });
  app.get('/merchant/timesheet.csv', reports, async (request, reply) => {
    const r = Range.parse(request.query);
    const t = await timesheet(db, asMerchantUser(request).merchant_id, r.from, r.to);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="hours-${r.from}-to-${r.to}.csv"`).send(timesheetCsv(t));
  });

  // Send a receipt later by text or email (P18b): the digital-receipt link, through the message sender.
  const sender = deps.messages ?? createMessageSender('log', deps.logger);
  app.post('/merchant/sales/:saleId/send-receipt', reports, async (request) => {
    const { saleId } = z.object({ saleId: z.uuid() }).parse(request.params);
    const body = z.strictObject({ channel: z.enum(['sms', 'email']), to: z.string().trim().min(3).max(200) }).parse(request.body);
    return sendReceipt(db, sender, asMerchantUser(request), saleId, body, deps.config.publicBaseUrl, request.logContext.trace_id);
  });

  // Equipment and support tickets from the store (P24a, Bible 2.8).
  app.get('/merchant/tickets', async (request) => ({ tickets: await listTickets(db, { merchantId: asMerchantUser(request).merchant_id }) }));
  app.post('/merchant/tickets', async (request, reply) => {
    const me = asMerchantUser(request);
    const b = MerchantTicketInput.parse(request.body);
    reply.status(201);
    return createTicket(db, me, { ...b, merchant_id: me.merchant_id, location_id: null, sale_id: null, priority: 'normal', source: 'merchant' }, request.logContext.trace_id);
  });
  app.get('/merchant/tickets/:ticketId', async (request) => {
    const { ticketId } = z.object({ ticketId: z.uuid() }).parse(request.params);
    return ticketDetail(db, ticketId, asMerchantUser(request).merchant_id);
  });
  app.post('/merchant/tickets/:ticketId/notes', async (request) => {
    const { ticketId } = z.object({ ticketId: z.uuid() }).parse(request.params);
    const { body } = z.strictObject({ body: z.string().trim().min(1).max(2000) }).parse(request.body);
    return addTicketNote(db, asMerchantUser(request), ticketId, { body }, request.logContext.trace_id);
  });
  app.get('/merchant/hardware', async (request) => ({ units: await listHardware(db, asMerchantUser(request).merchant_id) }));

  // Documents vault (P24b): the file is the raw request body, what it is goes in the query string.
  app.register(async (s) => {
    s.addContentTypeParser([...DOCUMENT_TYPES], { parseAs: 'buffer', bodyLimit: DOCUMENT_MAX_BYTES }, (_req, body, done) => done(null, body));
    const docs = { preHandler: requirePermission('documents.manage') };
    s.get('/merchant/documents', docs, async (request) => ({ documents: await listDocuments(db, asMerchantUser(request).merchant_id) }));
    s.post('/merchant/documents', docs, async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;
      const meta = DocumentMetaInput.parse({
        kind: q.kind,
        title: q.title,
        location_id: q.location_id || null,
        expires_on: q.expires_on || null,
        replaces: q.replaces || null,
      });
      if (!Buffer.isBuffer(request.body)) throw badRequest('Send the file as the request body (PDF, JPEG or PNG)');
      const type = validateDocument(request.body, request.headers['content-type']);
      reply.status(201);
      return uploadDocument(db, asMerchantUser(request), meta, request.body, type, request.logContext.trace_id);
    });
    s.get('/merchant/documents/:documentId/file', docs, async (request, reply) => {
      const { documentId } = z.object({ documentId: z.uuid() }).parse(request.params);
      const doc = await pgDocumentStore.get(db, asMerchantUser(request).merchant_id, documentId);
      if (!doc) throw notFound('Document not found');
      reply.header('content-type', doc.content_type).header('cache-control', 'private, no-store');
      return reply.send(doc.bytes);
    });
    s.post('/merchant/documents/:documentId/remove', docs, async (request) => {
      const { documentId } = z.object({ documentId: z.uuid() }).parse(request.params);
      await removeDocument(db, asMerchantUser(request), documentId, request.logContext.trace_id);
      return { ok: true };
    });
  });

  // Loyalty program and customers (P19a).
  const customers = { preHandler: requirePermission('customers.view') };
  app.get('/merchant/loyalty', async (request) => (await loyaltyConfig(db, asMerchantUser(request).merchant_id)).settings);
  app.put('/merchant/loyalty', { preHandler: requirePermission('catalog.edit') }, async (request) => {
    const me = asMerchantUser(request);
    return setLoyaltySettings(db, me, me.merchant_id, LoyaltySettingsInput.parse(request.body), request.logContext.trace_id);
  });
  app.get('/merchant/customers', customers, async (request) => {
    const me = asMerchantUser(request);
    const { settings } = await loyaltyConfig(db, me.merchant_id);
    return { customers: await customerList(db, me.merchant_id), loyalty: settings };
  });
  app.get('/merchant/customers/:ref', customers, async (request) => {
    const { ref } = z.object({ ref: CustomerRefSchema }).parse(request.params);
    return customerStatus(db, asMerchantUser(request).merchant_id, ref);
  });
  app.post('/merchant/customers/:ref/opt-out', customers, async (request) => {
    const { ref } = z.object({ ref: CustomerRefSchema }).parse(request.params);
    await optOut(db, asMerchantUser(request), ref, request.logContext.trace_id);
    return { ok: true };
  });
  app.post('/merchant/customers/promo', { preHandler: requirePermission('customers.message') }, async (request) => {
    const body = z.strictObject({ message: z.string().trim().min(3).max(240), top: z.int().min(1).max(1000).default(100) }).parse(request.body);
    return sendPromo(db, sender, asMerchantUser(request), body, request.logContext.trace_id);
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
