/**
 * Register routes. Identity and tenancy come from the device token alone.
 */
import { EventBatchSchema } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { asDevice, requireDevice } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import { getCatalogSnapshot } from '../services/catalog';
import { catalogVersion } from '../services/catalog-write';
import { ingestEvents } from '../services/events';
import { deviceIdentity } from '../services/onboarding';

export async function deviceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireDevice);

  app.get('/device/identity', async (request) => deviceIdentity(db, asDevice(request).register_id));

  /** Versioned catalog/config snapshot, pulled by the register (server wins on catalog). */
  app.get('/device/catalog', async (request) => {
    const d = asDevice(request);
    await db.query(`UPDATE registers SET last_seen_at = now() WHERE register_id = $1`, [d.register_id]);
    return getCatalogSnapshot(db, d.merchant_id, d.location_id);
  });

  /** Cheap staleness check: the register pulls the full snapshot only when this number moves. */
  app.get('/device/catalog/version', async (request) => {
    const d = asDevice(request);
    return { catalog_version: await catalogVersion(db, d.merchant_id) };
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
