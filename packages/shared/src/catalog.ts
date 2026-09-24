/**
 * Catalog write inputs, validated identically by the API and by every editor (admin, merchant app).
 * Money is integer cents; editors parse typed dollars with `parseUsdToCents` before sending.
 */
import { z } from 'zod';

const Cents = z.int().min(0).max(100_000_000);
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
