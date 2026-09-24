/**
 * Catalog management routes (build plan F1), mounted twice with the same handlers:
 *   /admin/merchants/:merchantId/…  — AD Pay staff, any merchant (admin guard applies)
 *   /merchant/…                     — a merchant's owner or manager, their own merchant only
 *
 * The merchant id for merchant users comes from their credential; there is no id in the path to
 * tamper with. Cashiers can read the catalog but not change it (full per-action permissions are P3).
 */
import {
  CategoryCreateInput,
  CategoryUpdateInput,
  ItemCreateInput,
  ItemUpdateInput,
  LocationRatesInput,
} from '@adpay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asAdmin, asMerchantUser, requireAdmin, requireMerchantUser } from '../http/auth-hooks';
import { forbidden } from '../http/errors';
import type { AppDeps } from '../server';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import {
  createCategory,
  createItem,
  merchantLocations,
  priceHistory,
  setLocationRates,
  updateCategory,
  updateItem,
  type CatalogActor,
} from '../services/catalog-write';

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
}
