/**
 * Catalog writes (build plan F1). Each write runs in one transaction that also:
 *  - bumps merchants.catalog_version, so registers can see their snapshot is stale;
 *  - records any price change in the append-only item_price_history;
 *  - writes an audit entry with the before/after of what changed.
 *
 * `merchantId` always comes from the caller's credential (merchant user) or an admin-scoped route;
 * every lookup is filtered by it, so an id from another merchant is a 404, never a cross-tenant write.
 */
import type { CategoryCreateInput, CategoryUpdateInput, ItemCreate, ItemUpdate, LocationRatesInput, PriceHistoryEntry } from '@adpay/shared';
import type { z } from 'zod';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';

export type CatalogActor = AdminPrincipal | MerchantUserPrincipal;

interface MerchantRow {
  org_id: string;
  merchant_id: string;
}

async function merchantFor(q: Queryable, merchantId: string): Promise<MerchantRow> {
  const { rows } = await q.query<MerchantRow>('SELECT org_id, merchant_id FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  return rows[0];
}

export async function bumpCatalogVersion(q: Queryable, merchantId: string): Promise<number> {
  const { rows } = await q.query<{ catalog_version: number }>(
    'UPDATE merchants SET catalog_version = catalog_version + 1 WHERE merchant_id = $1 RETURNING catalog_version',
    [merchantId],
  );
  return rows[0]!.catalog_version;
}

export async function catalogVersion(q: Queryable, merchantId: string): Promise<number> {
  const { rows } = await q.query<{ catalog_version: number }>('SELECT catalog_version FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  return rows[0].catalog_version;
}

async function assertCategory(q: Queryable, merchantId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const { rows } = await q.query('SELECT 1 FROM categories WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
  if (!rows[0]) throw badRequest('That category does not belong to this merchant');
}

const actorId = (a: CatalogActor) => a.user_id;

async function recordPrice(
  q: Queryable,
  m: MerchantRow,
  itemId: string,
  p: { cash_price_cents: number; card_price_cents: number | null; cost_cents: number | null },
  version: number,
  actor: CatalogActor,
  traceId: string,
) {
  await q.query(
    `INSERT INTO item_price_history (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, cost_cents,
                                     catalog_version, changed_by, changed_by_kind, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [m.org_id, m.merchant_id, itemId, p.cash_price_cents, p.card_price_cents, p.cost_cents, version, actorId(actor), actor.kind, traceId],
  );
}

async function replaceBarcodes(q: Queryable, m: MerchantRow, itemId: string, barcodes: { barcode: string; pack_qty: number }[]) {
  await q.query('DELETE FROM item_barcodes WHERE item_id = $1', [itemId]);
  for (const b of barcodes) {
    await q.query(
      'INSERT INTO item_barcodes (org_id, merchant_id, item_id, barcode, pack_qty) VALUES ($1, $2, $3, $4, $5)',
      [m.org_id, m.merchant_id, itemId, b.barcode, b.pack_qty],
    );
  }
}

export async function createItem(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  input: ItemCreate,
  traceId: string,
): Promise<{ item_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    await assertCategory(q, merchantId, input.category_id);
    const { rows } = await q.query<{ item_id: string }>(
      `INSERT INTO items (org_id, merchant_id, category_id, name, sku, upc, plu, cash_price_cents, card_price_cents,
                          cost_cents, open_price, sell_unit, pack_qty, active, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING item_id`,
      [
        m.org_id, m.merchant_id, input.category_id, input.name, input.sku, input.upc, input.plu, input.cash_price_cents,
        input.card_price_cents, input.cost_cents, input.open_price, input.sell_unit, input.pack_qty, input.active, actorId(actor),
      ],
    );
    const itemId = rows[0]!.item_id;
    await replaceBarcodes(q, m, itemId, input.barcodes);
    const version = await bumpCatalogVersion(q, merchantId);
    await recordPrice(q, m, itemId, input, version, actor, traceId);
    await audit(q, {
      actor,
      action: 'catalog.item_created',
      tenancy: m,
      target: itemId,
      details: { name: input.name, cash_price_cents: input.cash_price_cents, catalog_version: version },
      trace_id: traceId,
    });
    return { item_id: itemId, catalog_version: version };
  });
}

interface ItemRowFull {
  item_id: string;
  name: string;
  category_id: string | null;
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  upc: string | null;
  plu: string | null;
  sku: string | null;
  open_price: boolean;
  sell_unit: 'each' | 'pack';
  pack_qty: number;
  active: boolean;
}

const UPDATABLE = [
  'name', 'category_id', 'cash_price_cents', 'card_price_cents', 'cost_cents', 'upc', 'plu', 'sku',
  'open_price', 'sell_unit', 'pack_qty', 'active',
] as const;

export async function updateItem(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  itemId: string,
  patch: ItemUpdate,
  traceId: string,
): Promise<{ item_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const { rows } = await q.query<ItemRowFull>(
      `SELECT item_id, name, category_id, cash_price_cents, card_price_cents, cost_cents, upc, plu, sku, open_price,
              sell_unit, pack_qty, active
         FROM items WHERE item_id = $1 AND merchant_id = $2 FOR UPDATE`,
      [itemId, merchantId],
    );
    const before = rows[0];
    if (!before) throw notFound('Item not found');
    if (patch.category_id !== undefined) await assertCategory(q, merchantId, patch.category_id);

    const after: ItemRowFull = { ...before };
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of UPDATABLE) {
      const value = patch[key];
      if (value === undefined || value === before[key]) continue;
      changed[key] = { from: before[key], to: value };
      (after as unknown as Record<string, unknown>)[key] = value;
    }
    if (after.sell_unit === 'each' && after.pack_qty !== 1) throw badRequest('pack_qty must be 1 unless sold as a pack');

    const keys = Object.keys(changed);
    if (keys.length === 0 && patch.barcodes === undefined) return { item_id: itemId, catalog_version: await catalogVersion(q, merchantId) };

    if (keys.length > 0) {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`);
      await q.query(
        `UPDATE items SET ${sets.join(', ')}, updated_at = now(), updated_by = $${keys.length + 3} WHERE item_id = $1 AND merchant_id = $2`,
        [itemId, merchantId, ...keys.map((k) => (after as unknown as Record<string, unknown>)[k]), actorId(actor)],
      );
    }
    if (patch.barcodes !== undefined) await replaceBarcodes(q, m, itemId, patch.barcodes);

    const version = await bumpCatalogVersion(q, merchantId);
    if ('cash_price_cents' in changed || 'card_price_cents' in changed || 'cost_cents' in changed) {
      await recordPrice(q, m, itemId, after, version, actor, traceId);
    }
    await audit(q, {
      actor,
      action: 'catalog.item_updated',
      tenancy: m,
      target: itemId,
      details: { name: after.name, changed, barcodes_replaced: patch.barcodes !== undefined, catalog_version: version },
      trace_id: traceId,
    });
    return { item_id: itemId, catalog_version: version };
  });
}

export async function createCategory(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  input: z.infer<typeof CategoryCreateInput>,
  traceId: string,
): Promise<{ category_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const { rows } = await q.query<{ category_id: string }>(
      `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, color)
       VALUES ($1, $2, $3, coalesce($4, (SELECT coalesce(max(sort), -1) + 1 FROM categories WHERE merchant_id = $2)), $5, $6, $7)
       RETURNING category_id`,
      [m.org_id, m.merchant_id, input.name, input.sort ?? null, input.taxable, input.min_age, input.color],
    );
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, { actor, action: 'catalog.category_created', tenancy: m, target: rows[0]!.category_id, details: { ...input, catalog_version: version }, trace_id: traceId });
    return { category_id: rows[0]!.category_id, catalog_version: version };
  });
}

export async function updateCategory(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  categoryId: string,
  patch: z.infer<typeof CategoryUpdateInput>,
  traceId: string,
): Promise<{ category_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const keys = (['name', 'taxable', 'min_age', 'color', 'sort', 'active'] as const).filter((k) => patch[k] !== undefined);
    const { rows } = await q.query<{ category_id: string }>(
      `UPDATE categories SET ${keys.length ? keys.map((k, i) => `${k} = $${i + 3}`).join(', ') : 'name = name'}
        WHERE category_id = $1 AND merchant_id = $2 RETURNING category_id`,
      [categoryId, merchantId, ...keys.map((k) => patch[k])],
    );
    if (!rows[0]) throw notFound('Category not found');
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, { actor, action: 'catalog.category_updated', tenancy: m, target: categoryId, details: { ...patch, catalog_version: version }, trace_id: traceId });
    return { category_id: categoryId, catalog_version: version };
  });
}

/**
 * Change a location's dual-price % and/or sales tax rate. Card prices are derived from the %, so this
 * changes every non-overridden card price at that location — hence the catalog version bump.
 */
export async function setLocationRates(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  locationId: string,
  input: z.infer<typeof LocationRatesInput>,
  traceId: string,
): Promise<{ location_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; dual_price_rate_ppm: number; tax_rate_ppm: number }>(
      'SELECT org_id, dual_price_rate_ppm, tax_rate_ppm FROM locations WHERE location_id = $1 AND merchant_id = $2 FOR UPDATE',
      [locationId, merchantId],
    );
    const before = rows[0];
    if (!before) throw notFound('Location not found');
    await q.query(
      `UPDATE locations SET dual_price_rate_ppm = coalesce($3, dual_price_rate_ppm), tax_rate_ppm = coalesce($4, tax_rate_ppm)
        WHERE location_id = $1 AND merchant_id = $2`,
      [locationId, merchantId, input.dual_price_rate_ppm ?? null, input.tax_rate_ppm ?? null],
    );
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'location.rates_updated',
      tenancy: { org_id: before.org_id, merchant_id: merchantId, location_id: locationId },
      target: locationId,
      details: {
        dual_price_rate_ppm: { from: before.dual_price_rate_ppm, to: input.dual_price_rate_ppm ?? before.dual_price_rate_ppm },
        tax_rate_ppm: { from: before.tax_rate_ppm, to: input.tax_rate_ppm ?? before.tax_rate_ppm },
        catalog_version: version,
      },
      trace_id: traceId,
    });
    return { location_id: locationId, catalog_version: version };
  });
}

export async function priceHistory(q: Queryable, merchantId: string, itemId: string): Promise<PriceHistoryEntry[]> {
  const { rows } = await q.query<Omit<PriceHistoryEntry, 'changed_at'> & { changed_at: Date | string }>(
    `SELECT h.history_id, h.cash_price_cents, h.card_price_cents, h.cost_cents, h.catalog_version, h.changed_at,
            h.changed_by_kind, coalesce(u.name, u.email) AS changed_by_name
       FROM item_price_history h LEFT JOIN users u ON u.user_id = h.changed_by
      WHERE h.item_id = $1 AND h.merchant_id = $2
      ORDER BY h.changed_at DESC, h.catalog_version DESC
      LIMIT 100`,
    [itemId, merchantId],
  );
  return rows.map((r) => ({ ...r, changed_at: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at) }));
}

export interface LocationSummary {
  location_id: string;
  name: string;
  city: string | null;
  state: string | null;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

export async function merchantLocations(q: Queryable, merchantId: string): Promise<LocationSummary[]> {
  const { rows } = await q.query<LocationSummary>(
    `SELECT location_id, name, city, state, tax_rate_ppm, dual_price_rate_ppm
       FROM locations WHERE merchant_id = $1 ORDER BY created_at, name`,
    [merchantId],
  );
  return rows;
}
