/**
 * Register routes. Identity and tenancy come from the device token alone.
 */
import { DeviceItemCreateInput, EventBatchSchema } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asDevice, requireDevice } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { getCatalogSnapshot } from '../services/catalog';
import { catalogVersion, createItemFromDevice } from '../services/catalog-write';
import { ingestEvents } from '../services/events';
import { deviceIdentity } from '../services/onboarding';
import { cardRefund, terminalCharge } from '../services/payments';
import { registerStaff } from '../services/staff';

export async function deviceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireDevice);

  app.get('/device/identity', async (request) => deviceIdentity(db, asDevice(request).register_id));

  /** Versioned catalog/config snapshot, pulled by the register (server wins on catalog). */
  app.get('/device/catalog', async (request) => {
    const d = asDevice(request);
    await db.query(`UPDATE registers SET last_seen_at = now() WHERE register_id = $1`, [d.register_id]);
    // The register's config snapshot also carries who can sign in, so PINs work offline (P3).
    return { ...(await getCatalogSnapshot(db, d.merchant_id, d.location_id)), staff: await registerStaff(db, d.merchant_id) };
  });

  /** Cheap staleness check: the register pulls the full snapshot only when this number moves. */
  app.get('/device/catalog/version', async (request) => {
    const d = asDevice(request);
    return { catalog_version: await catalogVersion(db, d.merchant_id) };
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
