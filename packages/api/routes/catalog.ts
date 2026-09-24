/**
 * Catalog management routes (build plan F1), mounted twice with the same handlers:
 *   /admin/merchants/:merchantId/…  — AD Pay staff, any merchant (admin guard applies)
 *   /merchant/…                     — a merchant's owner or manager, their own merchant only
 *
 * The merchant id for merchant users comes from their credential; there is no id in the path to
 * tamper with. Cashiers can read the catalog but not change it (full per-action permissions are P3).
 */
import {
  CatalogOrderInput,
  CategoryCreateInput,
  CategoryUpdateInput,
  ItemCreateInput,
  ItemUpdateInput,
  LocationRatesInput,
  MEDIA_MAX_BYTES,
  MEDIA_TYPES,
  QuickKeysInput,
} from '@adpay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asAdmin, asMerchantUser, requireAdmin, requireMerchantUser } from '../http/auth-hooks';
import { badRequest, forbidden } from '../http/errors';
import type { AppDeps } from '../server';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import {
  createCategory,
  createItem,
  merchantLocations,
  priceHistory,
  reorderCatalog,
  setLocationRates,
  setQuickKeys,
  updateCategory,
  updateItem,
  uploadMedia,
  type CatalogActor,
} from '../services/catalog-write';
import { pgMediaStore, validateImage } from '../services/media';

interface Scope {
  prefix: string;
  guard: typeof requireAdmin;
  /** Resolve merchant + acting principal; throws for callers who may read but not write. */
  resolve: (r: FastifyRequest, write: boolean) => { merchantId: string; actor: CatalogActor };
}

const ADMIN: Scope = {
  prefix: '/admin/merchants/:merchantId',
  guard: requireAdmin,
  resolve: (r) => ({
    merchantId: z.object({ merchantId: z.uuid() }).parse(r.params).merchantId,
    actor: asAdmin(r),
  }),
};

const MERCHANT: Scope = {
  prefix: '/merchant',
  guard: requireMerchantUser,
  resolve: (r, write) => {
    const me = asMerchantUser(r);
    if (write && me.role === 'cashier') throw forbidden('Only an owner or manager can change the catalog');
    return { merchantId: me.merchant_id, actor: me };
  },
};

function mount(app: FastifyInstance, deps: AppDeps, scope: Scope) {
  const { db } = deps;
  const p = scope.prefix;
  const trace = (r: FastifyRequest) => r.logContext.trace_id;
  const ItemParams = z.object({ itemId: z.uuid() });

  app.register(async (s) => {
    s.addHook('preHandler', scope.guard);
    // Photos arrive as the raw image body (no multipart): the clients resize first, so it is small.
    s.addContentTypeParser([...MEDIA_TYPES], { parseAs: 'buffer', bodyLimit: MEDIA_MAX_BYTES }, (_req, body, done) => done(null, body));

    s.get(`${p}/locations`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      return { locations: await merchantLocations(db, merchantId) };
    });

    // Full catalog for editing, priced at a chosen location (default: the first).
    s.get(`${p}/catalog/editor`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { location_id } = z.object({ location_id: z.uuid().optional() }).parse(r.query);
      return getCatalogSnapshot(db, merchantId, location_id ?? (await defaultLocationId(db, merchantId)));
    });

    s.post(`${p}/items`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const input = ItemCreateInput.parse(r.body);
      reply.status(201);
      return createItem(db, actor, merchantId, input, trace(r));
    });

    s.patch(`${p}/items/:itemId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { itemId } = ItemParams.parse(r.params);
      return updateItem(db, actor, merchantId, itemId, ItemUpdateInput.parse(r.body), trace(r));
    });

    s.get(`${p}/items/:itemId/history`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { itemId } = ItemParams.parse(r.params);
      return { history: await priceHistory(db, merchantId, itemId) };
    });

    s.post(`${p}/categories`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return createCategory(db, actor, merchantId, CategoryCreateInput.parse(r.body), trace(r));
    });

    s.patch(`${p}/categories/:categoryId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { categoryId } = z.object({ categoryId: z.uuid() }).parse(r.params);
      return updateCategory(db, actor, merchantId, categoryId, CategoryUpdateInput.parse(r.body), trace(r));
    });

    s.post(`${p}/media`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      if (!Buffer.isBuffer(r.body)) throw badRequest('Send the photo as the request body (image/jpeg, image/png or image/webp)');
      const type = validateImage(r.body, r.headers['content-type']);
      reply.status(201);
      return uploadMedia(db, actor, merchantId, r.body, type, trace(r));
    });

    s.get(`${p}/locations/:locationId/quick-keys`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      const snap = await getCatalogSnapshot(db, merchantId, locationId);
      return { location_id: locationId, item_ids: snap.quick_keys };
    });

    s.put(`${p}/locations/:locationId/quick-keys`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setQuickKeys(db, actor, merchantId, locationId, QuickKeysInput.parse(r.body).item_ids, trace(r));
    });

    s.put(`${p}/catalog/order`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      return reorderCatalog(db, actor, merchantId, CatalogOrderInput.parse(r.body), trace(r));
    });

    s.patch(`${p}/locations/:locationId/rates`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setLocationRates(db, actor, merchantId, locationId, LocationRatesInput.parse(r.body), trace(r));
    });
  });
}

export async function catalogRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  mount(app, deps, ADMIN);
  mount(app, deps, MERCHANT);

  /**
   * Product photos, public by id so an <img> or a register tile can load them without a token.
   * The id is a random UUID (not guessable, not enumerable) and the content is a product photo the
   * merchant chose to show customers. Immutable, so it caches forever — which is also what lets a
   * register keep showing photos while offline.
   */
  app.get('/media/:mediaId', async (r, reply) => {
    const { mediaId } = z.object({ mediaId: z.uuid() }).parse(r.params);
    const m = await pgMediaStore.get(deps.db, mediaId);
    if (!m) return reply.status(404).send({ error: 'not_found', message: 'No such photo' });
    return reply
      .header('content-type', m.content_type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(m.bytes);
  });
}
