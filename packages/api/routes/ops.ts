/**
 * Ops routes (build plan P4 / F3, spec step 3).
 *   Device:   heartbeat (answers with queued actions), log upload, action result.
 *   Admin:    fleet list, device page, remote actions (audited), alert console.
 *   Merchant: their registers' status and their alert inbox.
 */
import { ActionResultInput, AlertSettingsInput, HeartbeatInput, LogUploadInput, RemoteActionRequest } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asAdmin, asDevice, asMerchantUser, requireAdmin, requireDevice, requireMerchantUser, requirePermission } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { acknowledgeAlert, evaluateAlerts, getAlertSettings, listAlerts, setAlertSettings } from '../services/alerts';
import { completeAction, devicePage, fleet, recordHeartbeat, requestAction, storeLogUpload } from '../services/ops';

const RegisterParams = z.object({ registerId: z.uuid() });
const AlertParams = z.object({ alertId: z.uuid() });
const AlertQuery = z.object({ open: z.enum(['1', '0']).default('1'), limit: z.coerce.number().int().min(1).max(500).default(200) });

export async function opsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.register(async (s) => {
    s.addHook('preHandler', requireDevice);

    s.post('/device/heartbeat', async (r) => recordHeartbeat(db, asDevice(r), HeartbeatInput.parse(r.body), r.logContext.trace_id));

    // A full 10k-line ring is ~1–2 MB of JSON.
    s.post('/device/logs', { bodyLimit: 4 * 1024 * 1024 }, async (r) => {
      const body = LogUploadInput.parse(r.body);
      return storeLogUpload(db, asDevice(r), body.action_id, body.lines, r.logContext.trace_id);
    });

    s.post('/device/actions/:actionId/result', async (r) => {
      const { actionId } = z.object({ actionId: z.uuid() }).parse(r.params);
      const body = ActionResultInput.parse(r.body);
      return completeAction(db, asDevice(r), actionId, body.status, body.message);
    });
  });

  app.register(async (s) => {
    s.addHook('preHandler', requireAdmin);

    s.get('/admin/fleet', async (r) => {
      const { merchant_id } = z.object({ merchant_id: z.uuid().optional() }).parse(r.query);
      return { registers: await fleet(db, merchant_id ?? null) };
    });

    s.get('/admin/registers/:registerId', async (r) => devicePage(db, RegisterParams.parse(r.params).registerId, null));

    s.post('/admin/registers/:registerId/actions', async (r, reply) => {
      const { registerId } = RegisterParams.parse(r.params);
      const body = RemoteActionRequest.parse(r.body);
      reply.status(201);
      return requestAction(db, asAdmin(r), registerId, body.kind, body.params, r.logContext.trace_id);
    });

    s.get('/admin/merchants/:merchantId/alert-settings', async (r) => getAlertSettings(db, z.object({ merchantId: z.uuid() }).parse(r.params).merchantId));
    s.put('/admin/merchants/:merchantId/alert-settings', async (r) => {
      const { merchantId } = z.object({ merchantId: z.uuid() }).parse(r.params);
      return setAlertSettings(db, asAdmin(r), merchantId, AlertSettingsInput.parse(r.body), r.logContext.trace_id);
    });

    s.get('/admin/alerts', async (r) => {
      const q = AlertQuery.parse(r.query);
      return { alerts: await listAlerts(db, { openOnly: q.open === '1', limit: q.limit }) };
    });

    s.post('/admin/alerts/:alertId/ack', async (r) => {
      await acknowledgeAlert(db, asAdmin(r), AlertParams.parse(r.params).alertId, r.logContext.trace_id);
      return { ok: true };
    });

    // Run the rules now instead of waiting for the next minute (support's "refresh" button).
    s.post('/admin/alerts/evaluate', async (r) => {
      const res = await evaluateAlerts(db, null, new Date(), r.logContext.trace_id);
      return { opened: res.opened.length, resolved: res.resolved, still_open: res.still_open };
    });
  });

  app.register(async (s) => {
    s.addHook('preHandler', requireMerchantUser);

    s.get('/merchant/registers', async (r) => ({ registers: await fleet(db, asMerchantUser(r).merchant_id) }));

    s.get('/merchant/alerts', async (r) => {
      const q = AlertQuery.parse(r.query);
      return { alerts: await listAlerts(db, { merchantId: asMerchantUser(r).merchant_id, merchantFacing: true, openOnly: q.open === '1', limit: q.limit }) };
    });

    // Alert settings (P11): mute rules, set the money thresholds. For people who see the figures.
    const reports = { preHandler: requirePermission('reports.view') };
    s.get('/merchant/alert-settings', reports, async (r) => getAlertSettings(db, asMerchantUser(r).merchant_id));
    s.put('/merchant/alert-settings', reports, async (r) => {
      const me = asMerchantUser(r);
      return setAlertSettings(db, me, me.merchant_id, AlertSettingsInput.parse(r.body), r.logContext.trace_id);
    });

    s.post('/merchant/alerts/:alertId/ack', async (r) => {
      await acknowledgeAlert(db, asMerchantUser(r), AlertParams.parse(r.params).alertId, r.logContext.trace_id);
      return { ok: true };
    });
  });
}
