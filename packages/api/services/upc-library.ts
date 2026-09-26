/**
 * The global UPC library (Bible 3.4; P25c, ADR 0041), read across every store's catalog on the
 * barcode key. Nothing is copied: the library is the stores' catalogs, deduped on read, so a store
 * fixing a name improves it for everyone and a deleted item leaves it.
 */
import { barcodeKey, foldSightings, isGlobalGtin, nameKey, type UpcSighting, type UpcSuggestion } from '@adpay/shared';
import type { Queryable } from '../db/db';

/** Every active listing of one barcode key, one row per (store, item). */
async function sightings(q: Queryable, key: string): Promise<UpcSighting[]> {
  const { rows } = await q.query<{ merchant_id: string; name: string; category: string | null; cash_price_cents: string | number }>(
    `SELECT i.merchant_id, i.name, c.name AS category, i.cash_price_cents
       FROM items i LEFT JOIN categories c ON c.category_id = i.category_id
      WHERE i.active AND (barcode_key(i.upc) = $1
            OR i.item_id IN (SELECT b.item_id FROM item_barcodes b WHERE barcode_key(b.barcode) = $1 AND b.pack_qty = 1))
      ORDER BY i.merchant_id, i.created_at`,
    [key],
  );
  return rows.map((r) => ({ ...r, cash_price_cents: Number(r.cash_price_cents) }));
}

/** A suggestion for a barcode a store doesn't have yet; null for store-made codes or when nobody has it. */
export async function upcLookup(q: Queryable, code: string): Promise<UpcSuggestion | null> {
  if (!isGlobalGtin(code)) return null;
  const key = barcodeKey(code);
  return foldSightings(key, await sightings(q, key));
}

export interface LibraryRow {
  barcode_key: string;
  barcode: string;
  name: string;
  stores: number;
  /** Different names (after normalising case / spacing / punctuation) stores use for it. */
  variants: number;
}

export interface LibraryOverview {
  gtins: number;
  shared: number;
  conflicts: number;
  rows: LibraryRow[];
}

/**
 * The library for support: every global GTIN in any catalog, how many stores carry it, and whether
 * they disagree on the name. `conflicts` narrows to the disagreements (worth a look before a
 * licensed dataset exists).
 */
export async function upcLibrary(q: Queryable, opts: { search?: string; conflicts?: boolean; limit?: number } = {}): Promise<LibraryOverview> {
  const { rows } = await q.query<{ barcode: string; merchant_id: string; name: string }>(
    `SELECT x.barcode, i.merchant_id, i.name
       FROM (SELECT item_id, upc AS barcode FROM items WHERE upc IS NOT NULL AND active
             UNION
             SELECT b.item_id, b.barcode FROM item_barcodes b JOIN items i2 ON i2.item_id = b.item_id WHERE b.pack_qty = 1 AND i2.active) x
       JOIN items i ON i.item_id = x.item_id`,
  );
  const byKey = new Map<string, { barcode: string; stores: Map<string, string> }>();
  for (const r of rows) {
    if (!isGlobalGtin(r.barcode)) continue;
    const k = barcodeKey(r.barcode);
    const g = byKey.get(k) ?? { barcode: r.barcode, stores: new Map() };
    if (!g.stores.has(r.merchant_id)) g.stores.set(r.merchant_id, r.name);
    byKey.set(k, g);
  }
  const all: LibraryRow[] = [...byKey.entries()].map(([key, g]) => {
    const f = foldSightings(key, [...g.stores.entries()].map(([merchant_id, name]) => ({ merchant_id, name, category: null, cash_price_cents: 0 })))!;
    return { barcode_key: key, barcode: g.barcode, name: f.name, stores: f.stores, variants: f.names.length };
  });
  const s = opts.search ? nameKey(opts.search) : '';
  const digits = opts.search?.replace(/\D/g, '').replace(/^0+/, '') ?? '';
  const filtered = all
    .filter((r) => !opts.conflicts || r.variants > 1)
    .filter((r) => !opts.search || (digits.length >= 4 && r.barcode_key.includes(digits)) || (s && nameKey(r.name).includes(s)))
    .sort((a, b) => b.stores - a.stores || b.variants - a.variants || a.name.localeCompare(b.name));
  return {
    gtins: all.length,
    shared: all.filter((r) => r.stores > 1).length,
    conflicts: all.filter((r) => r.variants > 1).length,
    rows: filtered.slice(0, opts.limit ?? 200),
  };
}
