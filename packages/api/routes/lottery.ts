/**
 * Lottery routes (build plan P17, ADR 0027): per location, for owners and managers (`reports.view`).
 * The merchant comes from the credential; a location of another merchant is a 404.
 */
import { LotteryCountInput, LotteryGameInput, lotteryCsv, PackActivateInput, PackReceiveInput, TerminalReportInput } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asMerchantUser, requireMerchantUser, requirePermission } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { addGame, games, lotteryDay, packs, receivePack, recordCount, setTerminalReport, updatePack } from '../services/lottery';

const Loc = z.object({ locationId: z.uuid() });
const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

export async function lotteryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireMerchantUser);
  const can = { preHandler: requirePermission('reports.view') };
  const p = '/merchant/locations/:locationId/lottery';
  const trace = (r: { logContext: { trace_id: string } }) => r.logContext.trace_id;

  app.get(`${p}`, can, async (r) => {
    const me = asMerchantUser(r);
    const { locationId } = Loc.parse(r.params);
    const [g, active] = await Promise.all([games(db, me.merchant_id, locationId), packs(db, me.merchant_id, locationId)]);
    return { games: g, packs: active };
  });
  app.post(`${p}/games`, can, async (r, reply) => {
    const me = asMerchantUser(r);
    reply.status(201);
    return addGame(db, me, me.merchant_id, Loc.parse(r.params).locationId, LotteryGameInput.parse(r.body), trace(r));
  });
  app.post(`${p}/packs`, can, async (r, reply) => {
    const me = asMerchantUser(r);
    reply.status(201);
    return receivePack(db, me, me.merchant_id, Loc.parse(r.params).locationId, PackReceiveInput.parse(r.body), trace(r));
  });
  app.post('/merchant/lottery/packs/:packId/activate', can, async (r) => {
    const me = asMerchantUser(r);
    const { packId } = z.object({ packId: z.uuid() }).parse(r.params);
    const a = PackActivateInput.parse(r.body);
    await updatePack(db, me, me.merchant_id, packId, { to: 'active', bin: a.bin, start_ticket: a.start_ticket }, trace(r));
    return { ok: true };
  });
  app.post('/merchant/lottery/packs/:packId/:to', can, async (r) => {
    const me = asMerchantUser(r);
    const { packId, to } = z.object({ packId: z.uuid(), to: z.enum(['sold_out', 'returned']) }).parse(r.params);
    await updatePack(db, me, me.merchant_id, packId, { to }, trace(r));
    return { ok: true };
  });
  app.post(`${p}/counts`, can, async (r, reply) => {
    const me = asMerchantUser(r);
    reply.status(201);
    return recordCount(db, me, me.merchant_id, Loc.parse(r.params).locationId, LotteryCountInput.parse(r.body), trace(r));
  });
  app.put(`${p}/terminal`, can, async (r) => {
    const me = asMerchantUser(r);
    await setTerminalReport(db, me, me.merchant_id, Loc.parse(r.params).locationId, TerminalReportInput.parse(r.body), trace(r));
    return { ok: true };
  });
  // The lottery part of the compliance export: one reconciled row per day, up to a quarter.
  app.get(`${p}/export.csv`, can, async (r, reply) => {
    const me = asMerchantUser(r);
    const { from, to } = z
      .object({ from: Day, to: Day })
      .refine((x) => x.from <= x.to && Date.parse(x.to) - Date.parse(x.from) <= 93 * 86_400_000, 'Up to 93 days')
      .parse(r.query);
    const locationId = Loc.parse(r.params).locationId;
    const days = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) {
      days.push(await lotteryDay(db, me.merchant_id, locationId, d.toISOString().slice(0, 10)));
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').send(lotteryCsv(days));
  });
  app.get(`${p}/day`, can, async (r) => {
    const me = asMerchantUser(r);
    const { date } = z.object({ date: Day }).parse(r.query);
    return lotteryDay(db, me.merchant_id, Loc.parse(r.params).locationId, date);
  });
}
