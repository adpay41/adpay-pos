/**
 * Catalog writes (build plan F1). Each write runs in one transaction that also:
 *  - bumps merchants.catalog_version, so registers can see their snapshot is stale;
 *  - records any price change in the append-only item_price_history;
 *  - writes an audit entry with the before/after of what changed.
 *
 * `merchantId` always comes from the caller's credential (merchant user) or an admin-scoped route;
 * every lookup is filtered by it, so an id from another merchant is a 404, never a cross-tenant write.
 */
import type {
  CategoryCreateInput,
  ComplianceSettings,
  CategoryUpdateInput,
  DeviceItemCreate,
  DeviceItemResult,
  ItemCreate,
  ItemUpdate,
  LocationRatesInput,
  MediaType,
  PriceHistoryEntry,
  ReceiptSettings,
} from '@adpay/shared';
import type { z } from 'zod';
import type { AdminPrincipal, DevicePrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { mediaUrl, pgMediaStore } from './media';

export type CatalogActor = AdminPrincipal | MerchantUserPrincipal;

interface MerchantRow {
  org_id: string;
  merchant_id: string;
}

export async function merchantFor(q: Queryable, merchantId: string): Promise<MerchantRow> {
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

async function assertImage(q: Queryable, merchantId: string, imageId: string | null | undefined) {
  if (!imageId) return;
  if (!(await pgMediaStore.owns(q, merchantId, imageId))) throw badRequest('That photo does not belong to this merchant');
}

async function assertCategory(q: Queryable, merchantId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const { rows } = await q.query('SELECT 1 FROM categories WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
  if (!rows[0]) throw badRequest('That category does not belong to this merchant');
}

const actorId = (a: CatalogActor) => a.user_id;

export async function recordPrice(
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
    await assertImage(q, merchantId, input.image_id);
    // New items go to the end of their category's keys unless an explicit position is given.
    const { rows } = await q.query<{ item_id: string }>(
      `INSERT INTO items (org_id, merchant_id, category_id, name, sku, upc, plu, cash_price_cents, card_price_cents,
                          cost_cents, open_price, sell_unit, pack_qty, active, updated_by, color, image_id, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               coalesce($18, (SELECT coalesce(max(sort), -1) + 1 FROM items WHERE merchant_id = $2 AND category_id IS NOT DISTINCT FROM $3)))
       RETURNING item_id`,
      [
        m.org_id, m.merchant_id, input.category_id, input.name, input.sku, input.upc, input.plu, input.cash_price_cents,
        input.card_price_cents, input.cost_cents, input.open_price, input.sell_unit, input.pack_qty, input.active, actorId(actor),
        input.color, input.image_id, input.sort ?? null,
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
  color: string | null;
  image_id: string | null;
  sort: number;
}

const UPDATABLE = [
  'name', 'category_id', 'cash_price_cents', 'card_price_cents', 'cost_cents', 'upc', 'plu', 'sku',
  'open_price', 'sell_unit', 'pack_qty', 'active', 'color', 'image_id', 'sort',
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
              sell_unit, pack_qty, active, color, image_id, sort
         FROM items WHERE item_id = $1 AND merchant_id = $2 FOR UPDATE`,
      [itemId, merchantId],
    );
    const before = rows[0];
    if (!before) throw notFound('Item not found');
    if (patch.category_id !== undefined) await assertCategory(q, merchantId, patch.category_id);
    if (patch.image_id !== undefined) await assertImage(q, merchantId, patch.image_id);

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
      `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, color, tax_class, restriction)
       VALUES ($1, $2, $3, coalesce($4, (SELECT coalesce(max(sort), -1) + 1 FROM categories WHERE merchant_id = $2)), $5, $6, $7, $8, $9)
       RETURNING category_id`,
      [m.org_id, m.merchant_id, input.name, input.sort ?? null, input.taxable, input.min_age, input.color, input.tax_class, input.restriction],
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
    const keys = (['name', 'taxable', 'min_age', 'tax_class', 'restriction', 'color', 'sort', 'active'] as const).filter((k) => patch[k] !== undefined);
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

/**
 * Replace a location's favorites (the register's first quick-key page) with `itemIds`, in order.
 * Every id must be one of this merchant's items; the whole list is written in one transaction.
 */
export async function setQuickKeys(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  locationId: string,
  itemIds: string[],
  traceId: string,
): Promise<{ location_id: string; item_ids: string[]; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows: locs } = await q.query<{ org_id: string }>(
      'SELECT org_id FROM locations WHERE location_id = $1 AND merchant_id = $2 FOR UPDATE',
      [locationId, merchantId],
    );
    const loc = locs[0];
    if (!loc) throw notFound('Location not found');
    if (itemIds.length > 0) {
      const { rows } = await q.query<{ item_id: string }>('SELECT item_id FROM items WHERE merchant_id = $1 AND item_id = ANY($2::uuid[])', [
        merchantId,
        itemIds,
      ]);
      if (rows.length !== itemIds.length) throw badRequest('Every favorite must be an item in this catalog');
    }
    const { rows: prev } = await q.query<{ item_id: string }>(
      'SELECT item_id FROM location_quick_keys WHERE location_id = $1 ORDER BY position',
      [locationId],
    );
    await q.query('DELETE FROM location_quick_keys WHERE location_id = $1', [locationId]);
    if (itemIds.length > 0) {
      await q.query(
        `INSERT INTO location_quick_keys (org_id, merchant_id, location_id, item_id, position)
         SELECT $1, $2, $3, id, ord - 1 FROM unnest($4::uuid[]) WITH ORDINALITY AS t(id, ord)`,
        [loc.org_id, merchantId, locationId, itemIds],
      );
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'location.quick_keys_set',
      tenancy: { org_id: loc.org_id, merchant_id: merchantId, location_id: locationId },
      target: locationId,
      details: { from: prev.map((r) => r.item_id), to: itemIds, catalog_version: version },
      trace_id: traceId,
    });
    return { location_id: locationId, item_ids: itemIds, catalog_version: version };
  });
}

/** Reorder categories and/or items in one write: each id's `sort` becomes its index in the list. */
export async function reorderCatalog(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  input: { categories?: string[] | undefined; items?: string[] | undefined },
  traceId: string,
): Promise<{ catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    for (const [table, key, ids] of [
      ['categories', 'category_id', input.categories],
      ['items', 'item_id', input.items],
    ] as const) {
      if (!ids?.length) continue;
      if (new Set(ids).size !== ids.length) throw badRequest(`Each ${key} may appear only once`);
      const { rows } = await q.query<{ n: number }>(
        `UPDATE ${table} t SET sort = u.ord - 1
           FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, ord)
          WHERE t.${key} = u.id AND t.merchant_id = $1
          RETURNING 1 AS n`,
        [merchantId, ids],
      );
      if (rows.length !== ids.length) throw badRequest(`Some ${table} are not in this catalog`);
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'catalog.reordered',
      tenancy: m,
      details: { categories: input.categories?.length ?? 0, items: input.items?.length ?? 0, catalog_version: version },
      trace_id: traceId,
    });
    return { catalog_version: version };
  });
}

/** Store an uploaded product photo for this merchant (validated by the caller) and audit it. */
export async function uploadMedia(
  db: Db,
  /** A register uploads the photo of a count sheet (P15); it has no user, so created_by is null. */
  actor: CatalogActor | DevicePrincipal,
  merchantId: string,
  bytes: Buffer,
  contentType: MediaType,
  traceId: string,
): Promise<{ media_id: string; url: string }> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const r = await pgMediaStore.put(q, { ...m, bytes, content_type: contentType, created_by: actor.kind === 'device' ? null : actorId(actor), trace_id: traceId });
    if (r.created) {
      await audit(q, {
        actor,
        action: 'media.uploaded',
        tenancy: m,
        target: r.media_id,
        details: { content_type: contentType, byte_size: bytes.length },
        trace_id: traceId,
      });
    }
    return { media_id: r.media_id, url: mediaUrl(r.media_id) };
  });
}

/**
 * An item created at a register from an unknown barcode (P5). Idempotent on the device-minted id:
 *  - the same command again → `exists` (no second item, no second version bump);
 *  - the barcode is already in the catalog (another register, or admin, got there first) → the
 *    device id becomes an alias of that item → `aliased`, and the register adopts the canonical id
 *    at its next catalog pull;
 *  - otherwise → a new item with the device's id → `created`.
 * The register checked the cashier's `item.create` permission; the audit entry names the register.
 */
export async function createItemFromDevice(
  db: Db,
  d: DevicePrincipal,
  input: DeviceItemCreate,
  traceId: string,
): Promise<DeviceItemResult> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, d.merchant_id);
    const version = async () => catalogVersion(q, d.merchant_id);

    const same = await q.query<{ item_id: string }>(
      `SELECT item_id FROM items WHERE item_id = $1 AND merchant_id = $2
        UNION ALL SELECT item_id FROM item_aliases WHERE alias_item_id = $1 AND merchant_id = $2`,
      [input.item_id, d.merchant_id],
    );
    if (same.rows[0]) {
      const canonical = same.rows[0].item_id;
      return { item_id: canonical, status: canonical === input.item_id ? 'exists' : 'aliased', catalog_version: await version() };
    }

    // Same product under another spelling of its barcode (UPC-A vs EAN-13 leading zeros) counts.
    const dup = await q.query<{ item_id: string }>(
      `SELECT item_id FROM items WHERE merchant_id = $1 AND upc IS NOT NULL
          AND (upc = $2 OR (upc ~ '^[0-9]+$' AND $2 ~ '^[0-9]+$' AND ltrim(upc, '0') = ltrim($2, '0')))
       UNION ALL
       SELECT item_id FROM item_barcodes WHERE merchant_id = $1
          AND (barcode = $2 OR (barcode ~ '^[0-9]+$' AND $2 ~ '^[0-9]+$' AND ltrim(barcode, '0') = ltrim($2, '0')))
       LIMIT 1`,
      [d.merchant_id, input.upc],
    );
    if (dup.rows[0]) {
      await q.query(
        `INSERT INTO item_aliases (alias_item_id, item_id, org_id, merchant_id, register_id) VALUES ($1, $2, $3, $4, $5)`,
        [input.item_id, dup.rows[0].item_id, m.org_id, m.merchant_id, d.register_id],
      );
      await audit(q, {
        actor: d,
        action: 'catalog.item_alias_from_register',
        tenancy: d,
        target: input.item_id,
        details: { item_id: dup.rows[0].item_id, upc: input.upc, name: input.name },
        trace_id: traceId,
      });
      return { item_id: dup.rows[0].item_id, status: 'aliased', catalog_version: await version() };
    }

    if (input.category_id) {
      const c = await q.query('SELECT 1 FROM categories WHERE category_id = $1 AND merchant_id = $2', [input.category_id, d.merchant_id]);
      if (!c.rows[0]) throw badRequest('That category does not belong to this merchant');
    }
    await q.query(
      `INSERT INTO items (item_id, org_id, merchant_id, category_id, name, upc, cash_price_cents, origin_register_id, created_at,
                          sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               (SELECT coalesce(max(sort), -1) + 1 FROM items WHERE merchant_id = $3 AND category_id IS NOT DISTINCT FROM $4))`,
      [input.item_id, m.org_id, m.merchant_id, input.category_id, input.name, input.upc, input.cash_price_cents, d.register_id, input.created_at],
    );
    const v = await bumpCatalogVersion(q, d.merchant_id);
    await q.query(
      `INSERT INTO item_price_history (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, cost_cents,
                                       catalog_version, changed_by, changed_by_kind, trace_id)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, 'device', $7)`,
      [m.org_id, m.merchant_id, input.item_id, input.cash_price_cents, v, input.created_by_user_id, traceId],
    );
    await audit(q, {
      actor: d,
      action: 'catalog.item_created_at_register',
      tenancy: d,
      target: input.item_id,
      details: { name: input.name, upc: input.upc, cash_price_cents: input.cash_price_cents, by_user_id: input.created_by_user_id, catalog_version: v },
      trace_id: traceId,
    });
    return { item_id: input.item_id, status: 'created', catalog_version: v };
  });
}

/** Replace a location's receipt settings (P8). The logo must be this merchant's own upload. */
export async function setReceiptSettings(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  locationId: string,
  settings: ReceiptSettings,
  traceId: string,
): Promise<{ location_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; receipt_settings: unknown }>(
      'SELECT org_id, receipt_settings FROM locations WHERE location_id = $1 AND merchant_id = $2 FOR UPDATE',
      [locationId, merchantId],
    );
    if (!rows[0]) throw notFound('Location not found');
    await assertImage(q, merchantId, settings.logo_media_id);
    await q.query('UPDATE locations SET receipt_settings = $3 WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId, JSON.stringify(settings)]);
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'location.receipt_settings_set',
      tenancy: { org_id: rows[0].org_id, merchant_id: merchantId, location_id: locationId },
      target: locationId,
      details: { from: rows[0].receipt_settings, to: settings, catalog_version: version },
      trace_id: traceId,
    });
    return { location_id: locationId, catalog_version: version };
  });
}

/**
 * Replace a location's tax & compliance rule set (P10, ADR 0018). Charge targets must be this
 * merchant's own categories and items. Bumps the catalog version so registers pull it.
 */
export async function setCompliance(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  locationId: string,
  settings: ComplianceSettings,
  traceId: string,
): Promise<{ location_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; compliance: unknown }>(
      'SELECT org_id, compliance FROM locations WHERE location_id = $1 AND merchant_id = $2 FOR UPDATE',
      [locationId, merchantId],
    );
    if (!rows[0]) throw notFound('Location not found');
    const catIds = [...new Set(settings.charges.flatMap((c) => c.category_ids))];
    const itemIds = [...new Set(settings.charges.flatMap((c) => c.item_ids))];
    if (catIds.length) {
      const { rows: n } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM categories WHERE merchant_id = $1 AND category_id = ANY($2::uuid[])', [merchantId, catIds]);
      if (n[0]!.n !== catIds.length) throw badRequest('A charge points at a category that is not in this catalog');
    }
    if (itemIds.length) {
      const { rows: n } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND item_id = ANY($2::uuid[])', [merchantId, itemIds]);
      if (n[0]!.n !== itemIds.length) throw badRequest('A charge points at an item that is not in this catalog');
    }
    await q.query('UPDATE locations SET compliance = $3 WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId, JSON.stringify(settings)]);
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'location.compliance_set',
      tenancy: { org_id: rows[0].org_id, merchant_id: merchantId, location_id: locationId },
      target: locationId,
      details: { from: rows[0].compliance, to: settings, catalog_version: version },
      trace_id: traceId,
    });
    return { location_id: locationId, catalog_version: version };
  });
}
