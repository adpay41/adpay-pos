/**
 * Bulk catalog writes (build plan P14, ADR 0023): CSV import and catalog templates share one path.
 *
 * One transaction, one catalog-version bump, one audit entry with the counts; every created item
 * and every price that changes gets its row in the append-only price history, as single edits do.
 * Matching: by barcode (UPC, or an extra barcode) first, then by name (case-insensitive). A dry
 * run computes the same plan and rolls back, so the preview is exactly what "Import" will do.
 */
import { CATALOG_TEMPLATES, type ImportRow } from '@adpay/shared';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, merchantFor, recordPrice, type CatalogActor } from './catalog-write';

export interface BulkRow extends Omit<ImportRow, 'line'> {
  line?: number;
  /** For a template: the category's settings when it has to be created. */
  category_defaults?: { taxable: boolean; min_age: number | null; restriction: string | null; color: string | null };
  sell_unit?: 'each' | 'pack';
  pack_qty?: number;
}

export interface BulkResult {
  dry_run: boolean;
  created: number;
  updated: number;
  unchanged: number;
  categories_created: string[];
  /** First 20 planned changes, for the preview. */
  sample: { line: number | null; name: string; action: 'create' | 'update' | 'unchanged'; from_cents: number | null; to_cents: number }[];
  catalog_version: number | null;
}

class DryRun extends Error {
  constructor(readonly result: BulkResult) {
    super('dry run');
  }
}

export async function bulkUpsert(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  rows: BulkRow[],
  opts: { dryRun: boolean; source: string },
  traceId: string,
): Promise<BulkResult> {
  if (rows.length === 0) throw badRequest('Nothing to import');
  try {
    return await db.tx(async (q) => {
      const result = await apply(q, actor, merchantId, rows, opts, traceId);
      if (opts.dryRun) throw new DryRun(result);
      return result;
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}

async function apply(q: Queryable, actor: CatalogActor, merchantId: string, rows: BulkRow[], opts: { dryRun: boolean; source: string }, traceId: string): Promise<BulkResult> {
  const m = await merchantFor(q, merchantId);
  const version = opts.dryRun ? 0 : await bumpCatalogVersion(q, merchantId);

  const { rows: cats } = await q.query<{ category_id: string; name: string }>('SELECT category_id, name FROM categories WHERE merchant_id = $1', [merchantId]);
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.category_id]));
  const { rows: items } = await q.query<{ item_id: string; name: string; upc: string | null; cash_price_cents: number; card_price_cents: number | null; cost_cents: number | null; category_id: string | null }>(
    'SELECT item_id, name, upc, cash_price_cents, card_price_cents, cost_cents, category_id FROM items WHERE merchant_id = $1',
    [merchantId],
  );
  const { rows: extra } = await q.query<{ barcode: string; item_id: string }>('SELECT barcode, item_id FROM item_barcodes WHERE merchant_id = $1', [merchantId]);
  const byCode = new Map<string, (typeof items)[number]>();
  for (const i of items) if (i.upc) byCode.set(i.upc, i);
  const byId = new Map(items.map((i) => [i.item_id, i]));
  for (const b of extra) if (byId.get(b.item_id)) byCode.set(b.barcode, byId.get(b.item_id)!);
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));

  const result: BulkResult = { dry_run: opts.dryRun, created: 0, updated: 0, unchanged: 0, categories_created: [], sample: [], catalog_version: opts.dryRun ? null : version };
  const note = (s: BulkResult['sample'][number]) => {
    if (result.sample.length < 20) result.sample.push(s);
  };

  for (const r of rows) {
    let categoryId: string | null = null;
    if (r.category) {
      categoryId = catByName.get(r.category.toLowerCase()) ?? null;
      if (!categoryId) {
        const d = r.category_defaults ?? { taxable: true, min_age: null, restriction: null, color: null };
        const { rows: made } = await q.query<{ category_id: string }>(
          `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, restriction, color)
           VALUES ($1, $2, $3, (SELECT coalesce(max(sort), -1) + 1 FROM categories WHERE merchant_id = $2), $4, $5, $6, $7) RETURNING category_id`,
          [m.org_id, merchantId, r.category, d.taxable, d.min_age, d.restriction, d.color],
        );
        categoryId = made[0]!.category_id;
        catByName.set(r.category.toLowerCase(), categoryId);
        result.categories_created.push(r.category);
      }
    }
    const hit = (r.upc ? byCode.get(r.upc) : undefined) ?? byName.get(r.name.toLowerCase());
    if (hit) {
      const next = {
        cash_price_cents: r.cash_price_cents,
        card_price_cents: r.card_price_cents ?? hit.card_price_cents,
        cost_cents: r.cost_cents ?? hit.cost_cents,
      };
      const priceChanged = next.cash_price_cents !== hit.cash_price_cents || next.card_price_cents !== hit.card_price_cents || next.cost_cents !== hit.cost_cents;
      const moved = categoryId !== null && categoryId !== hit.category_id;
      if (!priceChanged && !moved) {
        result.unchanged++;
        note({ line: r.line ?? null, name: hit.name, action: 'unchanged', from_cents: hit.cash_price_cents, to_cents: r.cash_price_cents });
        continue;
      }
      await q.query(
        `UPDATE items SET cash_price_cents = $3, card_price_cents = $4, cost_cents = $5, category_id = coalesce($6, category_id),
                          upc = coalesce(upc, $7), updated_by = $8, updated_at = now()
          WHERE item_id = $1 AND merchant_id = $2`,
        [hit.item_id, merchantId, next.cash_price_cents, next.card_price_cents, next.cost_cents, categoryId, r.upc, actor.user_id],
      );
      if (priceChanged) await recordPrice(q, m, hit.item_id, next, version, actor, traceId);
      note({ line: r.line ?? null, name: hit.name, action: 'update', from_cents: hit.cash_price_cents === next.cash_price_cents ? null : hit.cash_price_cents, to_cents: r.cash_price_cents });
      Object.assign(hit, next, moved ? { category_id: categoryId } : {});
      result.updated++;
    } else {
      const { rows: made } = await q.query<{ item_id: string }>(
        `INSERT INTO items (org_id, merchant_id, category_id, name, sku, upc, plu, cash_price_cents, card_price_cents, cost_cents, sell_unit, pack_qty, updated_by, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 (SELECT coalesce(max(sort), -1) + 1 FROM items WHERE merchant_id = $2 AND category_id IS NOT DISTINCT FROM $3))
         RETURNING item_id`,
        [m.org_id, merchantId, categoryId, r.name, r.sku, r.upc, r.plu, r.cash_price_cents, r.card_price_cents, r.cost_cents, r.sell_unit ?? 'each', r.pack_qty ?? 1, actor.user_id],
      );
      const created = { item_id: made[0]!.item_id, name: r.name, upc: r.upc, cash_price_cents: r.cash_price_cents, card_price_cents: r.card_price_cents, cost_cents: r.cost_cents, category_id: categoryId };
      await recordPrice(q, m, created.item_id, created, version, actor, traceId);
      if (r.upc) byCode.set(r.upc, created);
      byName.set(r.name.toLowerCase(), created);
      result.created++;
      note({ line: r.line ?? null, name: r.name, action: 'create', from_cents: null, to_cents: r.cash_price_cents });
    }
  }
  if (!opts.dryRun) {
    await audit(q, {
      actor,
      action: 'catalog.bulk_import',
      tenancy: m,
      target: merchantId,
      details: { source: opts.source, created: result.created, updated: result.updated, unchanged: result.unchanged, categories_created: result.categories_created, catalog_version: version },
      trace_id: traceId,
    });
  }
  return result;
}

/** A template as bulk rows: every category with its settings, every item at its suggested price. */
export function templateRows(templateId: string): BulkRow[] {
  const t = CATALOG_TEMPLATES[templateId];
  if (!t) throw notFound('No such catalog template');
  return t.categories.flatMap((c) =>
    (t.items[c.name] ?? []).map(
      (i): BulkRow => ({
        name: i.name,
        category: c.name,
        category_defaults: { taxable: c.taxable, min_age: c.min_age, restriction: c.restriction ?? null, color: c.color },
        cash_price_cents: i.cash,
        card_price_cents: i.card ?? null,
        cost_cents: null,
        upc: null,
        plu: null,
        sku: null,
        sell_unit: i.pack ? 'pack' : 'each',
        pack_qty: i.pack ?? 1,
      }),
    ),
  );
}
