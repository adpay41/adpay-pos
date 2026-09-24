/**
 * Catalog reads. Items live at merchant level; a location resolves them into posted prices using its
 * own dual-price rate and tax rate. Registers pull the result as a versioned snapshot — server wins
 * on catalog (ADR 0002).
 */
import {
  DEFAULT_RECEIPT_SETTINGS,
  ReceiptSettingsInput,
  resolveDualPrice,
  type CatalogCategory,
  type CatalogItem,
  type CatalogSnapshot,
  type ReceiptSettings,
  type TileColor,
} from '@adpay/shared';
import type { Queryable } from '../db/db';
import { notFound } from '../http/errors';
import { mediaUrl } from './media';

interface LocationRow {
  location_id: string;
  merchant_id: string;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
  catalog_version: number;
  receipt_settings: unknown;
}

/** Stored settings over the defaults; anything malformed falls back rather than breaking receipts. */
export function receiptSettingsOf(raw: unknown): ReceiptSettings {
  const parsed = ReceiptSettingsInput.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_RECEIPT_SETTINGS;
}

interface ItemRow {
  item_id: string;
  category_id: string | null;
  name: string;
  sku: string | null;
  upc: string | null;
  plu: string | null;
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  open_price: boolean;
  sell_unit: 'each' | 'pack';
  pack_qty: number;
  active: boolean;
  taxable: boolean | null;
  min_age: number | null;
  barcodes: { barcode: string; pack_qty: number }[] | null;
  color: TileColor | null;
  image_id: string | null;
  sort: number;
}

/** `merchantId` always comes from the caller's credential or an admin-scoped route, never the body. */
export async function getCatalogSnapshot(
  q: Queryable,
  merchantId: string,
  locationId: string,
): Promise<CatalogSnapshot> {
  const { rows: locs } = await q.query<LocationRow>(
    `SELECT l.location_id, l.merchant_id, l.tax_rate_ppm, l.dual_price_rate_ppm, m.catalog_version, l.receipt_settings
       FROM locations l JOIN merchants m ON m.merchant_id = l.merchant_id
      WHERE l.location_id = $1 AND l.merchant_id = $2`,
    [locationId, merchantId],
  );
  const loc = locs[0];
  if (!loc) throw notFound('Location not found');

  const { rows: categories } = await q.query<CatalogCategory>(
    `SELECT category_id, name, sort, taxable, min_age, color, active
       FROM categories WHERE merchant_id = $1 ORDER BY sort, name`,
    [merchantId],
  );
  const { rows: items } = await q.query<ItemRow>(
    `SELECT i.item_id, i.category_id, i.name, i.sku, i.upc, i.plu, i.cash_price_cents, i.card_price_cents,
            i.cost_cents, i.open_price, i.sell_unit, i.pack_qty, i.active, c.taxable, c.min_age, i.color, i.image_id, i.sort,
            (SELECT jsonb_agg(jsonb_build_object('barcode', b.barcode, 'pack_qty', b.pack_qty) ORDER BY b.barcode)
               FROM item_barcodes b WHERE b.item_id = i.item_id) AS barcodes
       FROM items i LEFT JOIN categories c ON c.category_id = i.category_id
      WHERE i.merchant_id = $1
      ORDER BY c.sort NULLS LAST, i.sort, i.name`,
    [merchantId],
  );
  const { rows: favorites } = await q.query<{ item_id: string }>(
    'SELECT item_id FROM location_quick_keys WHERE location_id = $1 ORDER BY position',
    [locationId],
  );

  return {
    merchant_id: merchantId,
    location_id: locationId,
    catalog_version: loc.catalog_version,
    dual_price_rate_ppm: loc.dual_price_rate_ppm,
    tax_rate_ppm: loc.tax_rate_ppm,
    generated_at: new Date().toISOString(),
    categories,
    items: items.map((i): CatalogItem => {
      const price = resolveDualPrice(i, loc.dual_price_rate_ppm);
      const taxable = i.taxable ?? true;
      return {
        item_id: i.item_id,
        category_id: i.category_id,
        name: i.name,
        sku: i.sku,
        upc: i.upc,
        plu: i.plu,
        barcodes: i.barcodes ?? [],
        cash_price_cents: price.cash,
        card_price_cents: price.card,
        card_price_override: i.card_price_cents !== null,
        open_price: i.open_price,
        cost_cents: i.cost_cents,
        taxable,
        tax_rate_ppm: taxable ? loc.tax_rate_ppm : 0,
        min_age: i.min_age,
        sell_unit: i.sell_unit,
        pack_qty: i.pack_qty,
        active: i.active,
        color: i.color,
        image_url: i.image_id ? mediaUrl(i.image_id) : null,
        sort: i.sort,
      };
    }),
    quick_keys: favorites.map((f) => f.item_id),
    receipt: (() => {
      const r = receiptSettingsOf(loc.receipt_settings);
      return { ...r, logo_url: r.logo_media_id ? mediaUrl(r.logo_media_id) : null };
    })(),
  };
}

/** First location of a merchant — used when a merchant-level view needs a price context. */
export async function defaultLocationId(q: Queryable, merchantId: string): Promise<string> {
  const { rows } = await q.query<{ location_id: string }>(
    `SELECT location_id FROM locations WHERE merchant_id = $1 ORDER BY created_at, name LIMIT 1`,
    [merchantId],
  );
  if (!rows[0]) throw notFound('Merchant has no locations');
  return rows[0].location_id;
}
