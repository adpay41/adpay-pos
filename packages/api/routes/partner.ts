/**
 * The partner API (Bible 3.4; P25a, ADR 0039): `/v1/*`, authenticated by an API key
 * (`Authorization: Bearer adp_…`), read-only, one merchant per key, each route behind a scope.
 * Money is integer cents; no card data and no customer data are ever returned.
 */
import type { ApiScope } from '@adpay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, unauthorized } from '../http/errors';
import type { AppDeps } from '../server';
import { defaultLocationId } from '../services/catalog';
import { stockLevels } from '../services/inventory';
import { partnerItems, partnerSales, resolveApiKey, type ApiKeyPrincipal } from '../services/partners';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyPrincipal;
  }
}

const Day = z.iso.date();
const Range = z
  .object({ from: Day, to: Day })
  .refine((r) => r.from <= r.to && Date.parse(r.to) - Date.parse(r.from) <= 31 * 86_400_000, 'Up to 31 days, from ≤ to');

function key(request: FastifyRequest, scope: ApiScope): ApiKeyPrincipal {
  const k = request.apiKey;
  if (!k) throw unauthorized();
  if (!k.scopes.includes(scope)) throw forbidden(`This key doesn't have the ${scope} scope`);
  return k;
}

export async function partnerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer adp_')) throw unauthorized('Send an API key: Authorization: Bearer adp_…');
    const k = await resolveApiKey(db, header.slice('Bearer '.length).trim());
    if (!k) throw unauthorized('That API key is not valid or was revoked');
    request.apiKey = k;
  });

  app.get('/v1/me', async (request) => {
    const k = request.apiKey!;
    return { merchant_id: k.merchant_id, scopes: k.scopes };
  });

  app.get('/v1/sales', async (request) => {
    const k = key(request, 'sales:read');
    const r = Range.parse(request.query);
    return { from: r.from, to: r.to, sales: await partnerSales(db, k.merchant_id, r.from, r.to) };
  });

  app.get('/v1/items', async (request) => ({ items: await partnerItems(db, key(request, 'catalog:read').merchant_id) }));

  app.get('/v1/inventory', async (request) => {
    const k = key(request, 'inventory:read');
    const { location_id } = z.object({ location_id: z.uuid().optional() }).parse(request.query);
    const location = location_id ?? (await defaultLocationId(db, k.merchant_id));
    const { rows } = await db.query('SELECT 1 FROM locations WHERE location_id = $1 AND merchant_id = $2', [location, k.merchant_id]);
    if (!rows.length) throw forbidden('That store is not this key’s merchant');
    const levels = await stockLevels(db, k.merchant_id, location);
    return { location_id: location, items: levels.items.map((i) => ({ item_id: i.item_id, name: i.name, on_hand: i.on_hand, reorder_point: i.reorder_point, low: i.low })) };
  });
}
