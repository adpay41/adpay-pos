/**
 * Catalog write inputs, validated identically by the API and by every editor (admin, merchant app).
 * Money is integer cents; editors parse typed dollars with `parseUsdToCents` before sending.
 */
import { z } from 'zod';
import type { CatalogItem, CatalogSnapshot } from './api';

const Cents = z.int().min(0).max(100_000_000);

/**
 * Quick-key tile colors. A fixed palette rather than free hex, so the brand rule holds on the
 * register: tiles sit next to prices, and **red is never near a dollar amount**. Green is left out
 * too, because it means "approved / money" on this product. Each color is a pale tile fill with a
 * strong stripe; the price text stays black on every one.
 */
export const TILE_COLORS = {
  blue: { fill: '#e7effb', stripe: '#1f5fbf', label: 'Blue' },
  teal: { fill: '#e3f4f4', stripe: '#0f7c80', label: 'Teal' },
  purple: { fill: '#efe9f8', stripe: '#6b3fb0', label: 'Purple' },
  orange: { fill: '#fdf0e2', stripe: '#c46a0c', label: 'Orange' },
  yellow: { fill: '#fdf8dc', stripe: '#a88a00', label: 'Yellow' },
  brown: { fill: '#f3ece6', stripe: '#7a5536', label: 'Brown' },
  gray: { fill: '#efefef', stripe: '#555555', label: 'Gray' },
  navy: { fill: '#e6e9f2', stripe: '#1f2d5c', label: 'Navy' },
} as const;
export type TileColor = keyof typeof TILE_COLORS;
export const TileColorInput = z.enum(Object.keys(TILE_COLORS) as [TileColor, ...TileColor[]]);

/** Most favorites a location can pin to the first quick-key page. */
export const MAX_QUICK_KEYS = 48;

export const QuickKeysInput = z.strictObject({
  item_ids: z
    .array(z.uuid())
    .max(MAX_QUICK_KEYS, `At most ${MAX_QUICK_KEYS} favorites`)
    .refine((ids) => new Set(ids).size === ids.length, 'An item can be a favorite only once'),
});

/** Reorder in one write: `sort` becomes the index in each list. */
export const CatalogOrderInput = z
  .strictObject({
    categories: z.array(z.uuid()).max(200).optional(),
    items: z.array(z.uuid()).max(2000).optional(),
  })
  .refine((v) => v.categories !== undefined || v.items !== undefined, 'Nothing to reorder');

/** Product photos: what the API accepts (the clients resize to ~512px JPEG before upload). */
export const MEDIA_MAX_BYTES = 1_000_000;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const Barcode = z.string().trim().regex(/^[0-9A-Za-z-]{4,32}$/, 'Barcodes are 4–32 letters/digits');
const Plu = z.string().trim().regex(/^\d{3,6}$/, 'PLU is 3–6 digits');

export const ItemBarcodeInput = z.strictObject({
  barcode: Barcode,
  pack_qty: z.int().min(1).max(1000).default(1),
});

export const ItemCreateInput = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    category_id: z.uuid().nullable(),
    cash_price_cents: Cents,
    /** null = derive the card price from each location's dual-price %. */
    card_price_cents: Cents.nullable().default(null),
    cost_cents: Cents.nullable().default(null),
    upc: Barcode.nullable().default(null),
    plu: Plu.nullable().default(null),
    sku: z.string().trim().max(40).nullable().default(null),
    open_price: z.boolean().default(false),
    sell_unit: z.enum(['each', 'pack']).default('each'),
    pack_qty: z.int().min(1).max(1000).default(1),
    barcodes: z.array(ItemBarcodeInput).max(20).default([]),
    active: z.boolean().default(true),
    color: TileColorInput.nullable().default(null),
    /** A `media_id` returned by the upload endpoint; must belong to the same merchant. */
    image_id: z.uuid().nullable().default(null),
    sort: z.int().min(0).max(100_000).optional(),
  })
  .refine((i) => i.sell_unit === 'pack' || i.pack_qty === 1, { message: 'pack_qty must be 1 unless sold as a pack', path: ['pack_qty'] });

export type ItemCreate = z.infer<typeof ItemCreateInput>;

/** Partial update: any subset of fields. `barcodes`, when present, replaces the list. */
export const ItemUpdateInput = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  category_id: z.uuid().nullable().optional(),
  cash_price_cents: Cents.optional(),
  card_price_cents: Cents.nullable().optional(),
  cost_cents: Cents.nullable().optional(),
  upc: Barcode.nullable().optional(),
  plu: Plu.nullable().optional(),
  sku: z.string().trim().max(40).nullable().optional(),
  open_price: z.boolean().optional(),
  sell_unit: z.enum(['each', 'pack']).optional(),
  pack_qty: z.int().min(1).max(1000).optional(),
  barcodes: z.array(ItemBarcodeInput).max(20).optional(),
  active: z.boolean().optional(),
  color: TileColorInput.nullable().optional(),
  image_id: z.uuid().nullable().optional(),
  sort: z.int().min(0).max(100_000).optional(),
});

export type ItemUpdate = z.infer<typeof ItemUpdateInput>;

export const CategoryCreateInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  taxable: z.boolean().default(true),
  min_age: z.int().min(1).max(99).nullable().default(null),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  sort: z.int().min(0).max(10_000).optional(),
});

export const CategoryUpdateInput = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  taxable: z.boolean().optional(),
  min_age: z.int().min(1).max(99).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  sort: z.int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

const Ppm = z.int().min(0).max(1_000_000);

/** Per-location pricing: the dual-price % that derives card prices, and the sales tax rate. */
export const LocationRatesInput = z
  .strictObject({
    dual_price_rate_ppm: Ppm.max(100_000, 'Card price markup above 10% is not allowed').optional(),
    tax_rate_ppm: Ppm.max(200_000).optional(),
  })
  .refine((v) => v.dual_price_rate_ppm !== undefined || v.tax_rate_ppm !== undefined, 'Nothing to change');

/** Percent text ("4", "6.625") → integer ppm, parsed as a decimal string — never a float. */
export function percentToPpm(input: string): number {
  const m = /^\s*(\d{1,3})(?:\.(\d{0,4}))?\s*%?\s*$/.exec(input);
  if (!m) throw new Error(`Not a percentage: ${input}`);
  return Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
}

/** Integer ppm → percent text for display ("66250" → "6.625"). */
export function ppmToPercent(ppm: number): string {
  const whole = Math.trunc(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Active items of one category in quick-key order: `sort`, then name. */
export function categoryKeys(snapshot: Pick<CatalogSnapshot, 'items'>, categoryId: string | null): CatalogItem[] {
  return snapshot.items
    .filter((i) => i.active && i.category_id === categoryId)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name)); // sort is absent in pre-P2 cached snapshots
}

/** The location's favorites page, in the order the merchant set; inactive or deleted items drop out. */
export function favoriteKeys(snapshot: Pick<CatalogSnapshot, 'items' | 'quick_keys'>): CatalogItem[] {
  const byId = new Map(snapshot.items.map((i) => [i.item_id, i]));
  return (snapshot.quick_keys ?? []).map((id) => byId.get(id)).filter((i): i is CatalogItem => !!i && i.active);
}

/**
 * An item created at the register from an unknown barcode (P5, Bible 1.1 "unknown barcode flow").
 * The device mints the id so it can sell the item immediately, offline. The server applies the
 * command idempotently: replaying it is a no-op, and if another register already created the same
 * barcode, the server keeps one item and records this id as an alias (see ADR 0013).
 */
export const DeviceItemCreateInput = z.strictObject({
  item_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  category_id: z.uuid().nullable(),
  cash_price_cents: Cents,
  upc: Barcode,
  created_by_user_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type DeviceItemCreate = z.infer<typeof DeviceItemCreateInput>;

export interface DeviceItemResult {
  /** The id the catalog uses: the device's own, or the existing item it was merged into. */
  item_id: string;
  status: 'created' | 'exists' | 'aliased';
  catalog_version: number;
}
