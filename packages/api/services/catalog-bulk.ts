/**
 * Bulk catalog writes (build plan P14, ADR 0023): CSV import, catalog templates and the NRS price
 * book migration (ADR 0043) share one path.
 *
 * One transaction, one catalog-version bump, one audit entry with the counts; every created item
 * and every price that changes gets its row in the append-only price history, as single edits do.
 * Matching: by barcode (UPC, or an extra barcode) first, then by the NRS key (an encrypted UPC from
 * an NRS CSV export), then by name (case-insensitive) onto an item that was already in the catalog.
 * A dry run computes the same plan and rolls back, so the preview is exactly what "Import" will do.
 */
import { randomUUID } from 'node:crypto';
import { CATALOG_TEMPLATES, type ImportRow, type NrsAttrs } from '@adpay/shared';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, merchantFor, type CatalogActor } from './catalog-write';

export interface BulkRow extends Omit<ImportRow, 'line'> {
  line?: number;
  /** For a template: the category's settings when it has to be created. */
  category_defaults?: { taxable: boolean; min_age: number | null; restriction: string | null; color: string | null };
  sell_unit?: 'each' | 'pack';
  pack_qty?: number;
  /** From an NRS price book (ADR 0043). */
  open_price?: boolean;
  /** The price already includes the tax (ADR 0044); NRS `includes_taxes`. */
  tax_included?: boolean;
  active?: boolean;
  nrs?: NrsAttrs;
  unit_upc?: string | null;
  unit_count?: number | null;
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
  /** Packs tied to their single unit for stock (NRS unit_upc / unit_count). */
  packs_linked?: number;
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
  opts: { dryRun: boolean; source: string; renames?: boolean },
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

interface Existing {
  item_id: string;
  name: string;
  upc: string | null;
  plu: string | null;
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  category_id: string | null;
  open_price: boolean;
  tax_included: boolean;
  nrs: NrsAttrs | null;
}

async function apply(q: Queryable, actor: CatalogActor, merchantId: string, rows: BulkRow[], opts: { dryRun: boolean; source: string; renames?: boolean }, traceId: string): Promise<BulkResult> {
  const m = await merchantFor(q, merchantId);
  const version = opts.dryRun ? 0 : await bumpCatalogVersion(q, merchantId);

  const { rows: cats } = await q.query<{ category_id: string; name: string }>('SELECT category_id, name FROM categories WHERE merchant_id = $1', [merchantId]);
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.category_id]));
  const { rows: items } = await q.query<Existing>(
    `SELECT item_id, name, upc, plu, cash_price_cents::int AS cash_price_cents, card_price_cents::int AS card_price_cents, cost_cents::int AS cost_cents,
            category_id, open_price, tax_included, attrs->'nrs' AS nrs
       FROM items WHERE merchant_id = $1`,
    [merchantId],
  );
  const { rows: extra } = await q.query<{ barcode: string; item_id: string }>('SELECT barcode, item_id FROM item_barcodes WHERE merchant_id = $1', [merchantId]);
  const byCode = new Map<string, Existing>();
  for (const i of items) if (i.upc) byCode.set(i.upc, i);
  const byId = new Map(items.map((i) => [i.item_id, i]));
  for (const b of extra) if (byId.get(b.item_id)) byCode.set(b.barcode, byId.get(b.item_id)!);
  const byKey = new Map<string, Existing>();
  for (const i of items) if (i.nrs?.key) byKey.set(i.nrs.key, i);
  // Name is the last resort, and only onto an item that was in the catalog before this import, each
  // claimed once: a price book with one name on two barcodes ("Kleenex") makes two items. A row
  // with a barcode only takes over an item that has none (attaching the barcode to it).
  const byName = new Map<string, Existing[]>();
  for (const i of items) {
    const k = i.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), i]);
  }
  const claimed = new Set<string>();
  // Items some row of this file reaches by barcode or NRS key are that row's: never taken by name.
  const reserved = new Set<string>();
  for (const r of rows) {
    const own = (r.upc ? byCode.get(r.upc) : undefined) ?? (r.nrs?.key ? byKey.get(r.nrs.key) : undefined);
    if (own) reserved.add(own.item_id);
  }
  const usedPlu = new Set(items.map((i) => i.plu).filter((p): p is string => !!p));
  const itemIdByCode = new Map<string, string>();
  // New items go to the end of their category, as single adds do.
  const { rows: sorts } = await q.query<{ category_id: string | null; next: number }>(
    'SELECT category_id, max(sort) + 1 AS next FROM items WHERE merchant_id = $1 GROUP BY category_id',
    [merchantId],
  );
  const nextSort = new Map(sorts.map((s) => [s.category_id ?? '', Number(s.next)]));
  // Planned in memory, written in batches: a 9,000-item price book is a handful of statements.
  const creates: (Existing & { sku: string | null; sell_unit: string; pack_qty: number; sort: number; active: boolean })[] = [];
  const updates: { id: string; cash_price_cents: number; card_price_cents: number | null; cost_cents: number | null; category_id: string | null; upc: string | null; name: string; open_price: boolean; tax_included: boolean; nrs: string | null; plu: string | null }[] = [];
  const prices: { id: string; cash_price_cents: number; card_price_cents: number | null; cost_cents: number | null }[] = [];

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
    const named = (byName.get(r.name.toLowerCase()) ?? []).find((i) => !claimed.has(i.item_id) && !reserved.has(i.item_id) && (!r.upc || !i.upc));
    const hit =
      (r.upc ? byCode.get(r.upc) : undefined) ??
      (r.nrs?.key ? byKey.get(r.nrs.key) : undefined) ??
      named;
    if (hit && claimed.has(hit.item_id)) {
      // Two rows for one item (a barcode that is also another item's extra barcode): the first wins.
      result.unchanged++;
      continue;
    }
    if (hit) {
      claimed.add(hit.item_id);
      if (r.upc) itemIdByCode.set(r.upc, hit.item_id);
      const next = {
        cash_price_cents: r.cash_price_cents,
        card_price_cents: r.card_price_cents ?? hit.card_price_cents,
        cost_cents: r.cost_cents ?? hit.cost_cents,
      };
      const name = opts.renames ? r.name : hit.name;
      const openPrice = r.open_price ?? hit.open_price;
      const taxIncluded = r.tax_included ?? hit.tax_included;
      const nrs = r.nrs ?? hit.nrs;
      const priceChanged = next.cash_price_cents !== hit.cash_price_cents || next.card_price_cents !== hit.card_price_cents || next.cost_cents !== hit.cost_cents;
      const moved = categoryId !== null && categoryId !== hit.category_id;
      const otherChanged = name !== hit.name || openPrice !== hit.open_price || taxIncluded !== hit.tax_included || !sameNrs(nrs, hit.nrs) || (!!r.upc && !hit.upc);
      if (!priceChanged && !moved && !otherChanged) {
        result.unchanged++;
        note({ line: r.line ?? null, name: hit.name, action: 'unchanged', from_cents: hit.cash_price_cents, to_cents: r.cash_price_cents });
        continue;
      }
      const plu = !hit.plu && r.plu && !usedPlu.has(r.plu) ? r.plu : null;
      if (plu) usedPlu.add(plu);
      updates.push({ id: hit.item_id, ...next, category_id: categoryId, upc: r.upc, name, open_price: openPrice, tax_included: taxIncluded, nrs: nrs ? JSON.stringify(nrs) : null, plu });
      if (priceChanged) prices.push({ id: hit.item_id, ...next });
      note({ line: r.line ?? null, name, action: 'update', from_cents: hit.cash_price_cents === next.cash_price_cents ? null : hit.cash_price_cents, to_cents: r.cash_price_cents });
      Object.assign(hit, next, { name, open_price: openPrice, tax_included: taxIncluded, nrs, upc: hit.upc ?? r.upc }, moved ? { category_id: categoryId } : {});
      result.updated++;
    } else {
      const plu = r.plu && !usedPlu.has(r.plu) ? r.plu : null;
      if (plu) usedPlu.add(plu);
      const sortKey = categoryId ?? '';
      const sort = nextSort.get(sortKey) ?? 0;
      nextSort.set(sortKey, sort + 1);
      const created: Existing = {
        item_id: randomUUID(), name: r.name, upc: r.upc, plu, cash_price_cents: r.cash_price_cents, card_price_cents: r.card_price_cents, cost_cents: r.cost_cents,
        category_id: categoryId, open_price: r.open_price ?? false, tax_included: r.tax_included ?? false, nrs: r.nrs ?? null,
      };
      creates.push({ ...created, sku: r.sku, sell_unit: r.sell_unit ?? 'each', pack_qty: r.pack_qty ?? 1, sort, active: r.active ?? true });
      prices.push({ id: created.item_id, cash_price_cents: r.cash_price_cents, card_price_cents: r.card_price_cents, cost_cents: r.cost_cents });
      claimed.add(created.item_id);
      if (r.upc) {
        byCode.set(r.upc, created);
        itemIdByCode.set(r.upc, created.item_id);
      }
      if (r.nrs?.key) byKey.set(r.nrs.key, created);
      result.created++;
      note({ line: r.line ?? null, name: r.name, action: 'create', from_cents: null, to_cents: r.cash_price_cents });
    }
  }

  for (const c of chunks(creates)) {
    await q.query(
      `INSERT INTO items (item_id, org_id, merchant_id, category_id, name, sku, upc, plu, cash_price_cents, card_price_cents, cost_cents, sell_unit, pack_qty,
                          updated_by, sort, open_price, active, attrs, tax_included)
       SELECT t.id, $1, $2, t.cat, t.name, t.sku, t.upc, t.plu, t.cash, t.card, t.cost, t.unit, t.pack, $3, t.sort, t.open, t.active,
              CASE WHEN t.nrs IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('nrs', t.nrs) END, t.incl
         FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::bigint[], $11::bigint[], $12::bigint[], $13::text[], $14::int[],
                     $15::int[], $16::bool[], $17::bool[], $18::jsonb[], $19::bool[])
           AS t(id, cat, name, sku, upc, plu, cash, card, cost, unit, pack, sort, open, active, nrs, incl)`,
      [
        m.org_id, merchantId, actor.user_id,
        c.map((x) => x.item_id), c.map((x) => x.category_id), c.map((x) => x.name), c.map((x) => x.sku), c.map((x) => x.upc), c.map((x) => x.plu),
        c.map((x) => x.cash_price_cents), c.map((x) => x.card_price_cents), c.map((x) => x.cost_cents), c.map((x) => x.sell_unit), c.map((x) => x.pack_qty),
        c.map((x) => x.sort), c.map((x) => x.open_price), c.map((x) => x.active), c.map((x) => (x.nrs ? JSON.stringify(x.nrs) : null)),
        c.map((x) => x.tax_included),
      ],
    );
  }
  for (const c of chunks(updates)) {
    await q.query(
      `UPDATE items i SET cash_price_cents = t.cash, card_price_cents = t.card, cost_cents = t.cost, category_id = coalesce(t.cat, i.category_id),
                          upc = coalesce(i.upc, t.upc), updated_by = $2, updated_at = now(), name = t.name, open_price = t.open,
                          attrs = CASE WHEN t.nrs IS NULL THEN i.attrs ELSE i.attrs || jsonb_build_object('nrs', t.nrs) END,
                          plu = coalesce(i.plu, t.plu), tax_included = t.incl
         FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[], $7::uuid[], $8::text[], $9::text[], $10::bool[], $11::jsonb[], $12::text[], $13::bool[])
           AS t(id, cash, card, cost, cat, upc, name, open, nrs, plu, incl)
        WHERE i.item_id = t.id AND i.merchant_id = $1`,
      [
        merchantId, actor.user_id,
        c.map((x) => x.id), c.map((x) => x.cash_price_cents), c.map((x) => x.card_price_cents), c.map((x) => x.cost_cents), c.map((x) => x.category_id),
        c.map((x) => x.upc), c.map((x) => x.name), c.map((x) => x.open_price), c.map((x) => x.nrs), c.map((x) => x.plu),
        c.map((x) => x.tax_included),
      ],
    );
  }
  for (const c of chunks(prices)) {
    await q.query(
      `INSERT INTO item_price_history (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, cost_cents, catalog_version, changed_by, changed_by_kind, trace_id)
       SELECT $1, $2, t.id, t.cash, t.card, t.cost, $3, $4, $5, $6
         FROM unnest($7::uuid[], $8::bigint[], $9::bigint[], $10::bigint[]) AS t(id, cash, card, cost)`,
      [m.org_id, merchantId, version, actor.user_id, actor.kind, traceId, c.map((x) => x.id), c.map((x) => x.cash_price_cents), c.map((x) => x.card_price_cents), c.map((x) => x.cost_cents)],
    );
  }

  // Packs whose single unit is another item: stock is counted on the unit (case-break, ADR 0034).
  for (const r of rows) {
    if (!r.upc || !r.unit_upc || !r.unit_count) continue;
    const pack = itemIdByCode.get(r.upc);
    const unit = itemIdByCode.get(r.unit_upc) ?? byCode.get(r.unit_upc)?.item_id;
    if (!pack || !unit || pack === unit) continue;
    await q.query('UPDATE items SET stock_of = $3, stock_ratio = $4 WHERE item_id = $1 AND merchant_id = $2', [pack, merchantId, unit, r.unit_count]);
    result.packs_linked = (result.packs_linked ?? 0) + 1;
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

function chunks<T>(xs: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** jsonb comes back with its keys in its own order; compare field by field. */
function sameNrs(a: NrsAttrs | null, b: NrsAttrs | null): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof NrsAttrs)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
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
