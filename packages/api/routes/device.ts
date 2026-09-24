/**
 * Register routes. Identity and tenancy come from the device token alone.
 */
import { DeviceItemCreateInput, EventBatchSchema, MEDIA_MAX_BYTES, MEDIA_TYPES, UsualInput } from '@adpay/shared';
import { badRequest } from '../http/errors';
import { validateImage } from '../services/media';
import { salesCompare } from '../services/reports';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asDevice, requireDevice } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { getCatalogSnapshot } from '../services/catalog';
import { catalogVersion, createItemFromDevice, uploadMedia } from '../services/catalog-write';
import { ingestEvents } from '../services/events';
import { deviceIdentity } from '../services/onboarding';
import { cardRefund, terminalCharge } from '../services/payments';
import { registerStaff } from '../services/staff';
import { removeUsual, saveUsual, usualsFor } from '../services/usuals';

export async function deviceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireDevice);
  // A photo of the closing count sheet arrives as the raw image body (P15), like product photos.
  app.addContentTypeParser([...MEDIA_TYPES], { parseAs: 'buffer', bodyLimit: MEDIA_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.post('/device/media', async (request, reply) => {
    const d = asDevice(request);
    if (!Buffer.isBuffer(request.body)) throw badRequest('Send the photo as the request body (image/jpeg)');
    const type = validateImage(request.body, request.headers['content-type']);
    reply.status(201);
    return uploadMedia(db, d, d.merchant_id, request.body, type, request.logContext.trace_id);
  });

  /** The hourly target ribbon (P15, Bible 1.10): today so far vs yesterday by this time, this store. */
  app.get('/device/pulse', async (request) => {
    const d = asDevice(request);
    const c = await salesCompare(db, d.merchant_id, d.location_id);
    const [today, yesterday] = c.days;
    return { as_of: c.as_of, today_cents: today!.so_far_cents, yesterday_cents: yesterday!.so_far_cents, vs_yesterday_tenths: c.vs_yesterday_tenths };
  });

  app.get('/device/identity', async (request) => deviceIdentity(db, asDevice(request).register_id));

  /** Versioned catalog/config snapshot, pulled by the register (server wins on catalog). */
  app.get('/device/catalog', async (request) => {
    const d = asDevice(request);
    await db.query(`UPDATE registers SET last_seen_at = now() WHERE register_id = $1`, [d.register_id]);
    // The register's config snapshot also carries who can sign in, so PINs work offline (P3).
    return { ...(await getCatalogSnapshot(db, d.merchant_id, d.location_id)), staff: await registerStaff(db, d.merchant_id), usuals: await usualsFor(db, d.merchant_id) };
  });

  /** Cheap staleness check: the register pulls the full snapshot only when this number moves. */
  app.get('/device/catalog/version', async (request) => {
    const d = asDevice(request);
    return { catalog_version: await catalogVersion(db, d.merchant_id) };
  });

  /** "The usual" (P14): save a ticket as a cashier's preset, or remove one. Online only; config, not ledger. */
  app.post('/device/usuals', async (request, reply) => {
    reply.status(201);
    return saveUsual(db, asDevice(request), UsualInput.parse(request.body), request.logContext.trace_id);
  });
  app.post('/device/usuals/:usualId/remove', async (request) => {
    const { usualId } = z.object({ usualId: z.uuid() }).parse(request.params);
    return removeUsual(db, asDevice(request), usualId, request.logContext.trace_id);
  });

  /** An item created at this register from an unknown barcode (P5). Idempotent on its device-minted id. */
  app.post('/device/items', async (request) => {
    const d = asDevice(request);
    return createItemFromDevice(db, d, DeviceItemCreateInput.parse(request.body), request.logContext.trace_id);
  });

  // Card payments (P9): amounts and ids only; the provider drives the terminal. Idempotent by the
  // register-minted tender_id / refund_id, so a retry never charges or refunds twice.
  app.post('/device/payments/terminal-charge', async (request) => {
    const body = z.strictObject({ sale_id: z.uuid(), tender_id: z.uuid(), amount_cents: z.int().positive().max(10_000_00) }).parse(request.body);
    return terminalCharge(db, deps.payments, asDevice(request), body, request.logContext.trace_id);
  });

  app.post('/device/payments/card-refund', async (request) => {
    const body = z.strictObject({ sale_id: z.uuid(), refund_id: z.uuid(), provider_ref: z.string().min(1).max(200), amount_cents: z.int().positive().max(10_000_00) }).parse(request.body);
    return cardRefund(db, deps.payments, asDevice(request), body, request.logContext.trace_id);
  });

  app.get('/device/payments/terminal', async (request) => {
    const d = asDevice(request);
    return { provider: deps.payments.name, ...(await deps.payments.terminalStatus(d.register_id)) };
  });

  /** Append-only, idempotent event push (device wins on sales). Safe to retry any number of times. */
  app.post('/device/events', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const d = asDevice(request);
    const { events } = EventBatchSchema.parse(request.body);
    const result = await ingestEvents(db, d, events);
    request.log.info(
      { accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length },
      'event batch ingested',
    );
    return result;
  });
}
