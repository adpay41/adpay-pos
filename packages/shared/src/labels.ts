/**
 * Shelf tags and barcode labels (Bible 1.6 "shelf tags with cash and card price (dual-pricing
 * compliance), barcode labels for open-price items", 2.3 "shelf label print queue"; build plan P21,
 * ADR 0033).
 *
 * Pure and shared: the label layout, what a tag says, and the barcode symbologies (UPC-A, EAN-13,
 * Code 128) as module strings, so the PDF on the server and any on-screen preview draw the same bars.
 * Price-embedded UPC-A ("2" + PLU + price) lets a deli print a label for a made-to-order item that the
 * register rings at the printed price.
 */
import { z } from 'zod';
import { formatUsd, cents } from './money';

// --- Templates ------------------------------------------------------------------------------------

/**
 * Label stock. Sizes in points (1/72 in). `avery_5160` prints on any office printer (30 per US Letter
 * sheet); `thermal_2x1` is one 2.25″ × 1.25″ label per page, the common thermal shelf-label size.
 */
export const LABEL_SIZES = {
  avery_5160: { label: 'Avery 5160 sheet (any printer, 30 per page)', page: { w: 612, h: 792 }, cell: { w: 189, h: 72 }, cols: 3, rows: 10, margin: { left: 13.5, top: 36 }, gap: { x: 9, y: 0 } },
  thermal_2x1: { label: 'Thermal label 2.25″ × 1.25″ (label printer)', page: { w: 162, h: 90 }, cell: { w: 162, h: 90 }, cols: 1, rows: 1, margin: { left: 0, top: 0 }, gap: { x: 0, y: 0 } },
} as const;
export type LabelSize = keyof typeof LABEL_SIZES;

export const LabelTemplateInput = z.strictObject({
  name: z.string().trim().min(1).max(40),
  size: z.enum(Object.keys(LABEL_SIZES) as [LabelSize, ...LabelSize[]]),
  /** NJ/NY dual pricing: the card price is on the tag unless the store turns it off (not advised). */
  show_card_price: z.boolean().default(true),
  show_barcode: z.boolean().default(true),
  show_category: z.boolean().default(false),
  /** A short line under the prices, e.g. "Cash price / Card price". */
  note: z.string().trim().max(40).nullable().default('Cash price · Card price'),
});
export type LabelTemplateInput = z.infer<typeof LabelTemplateInput>;
export const DEFAULT_LABEL_TEMPLATE: LabelTemplateInput = LabelTemplateInput.parse({ name: 'Shelf tag', size: 'avery_5160' });

export interface TagItem {
  name: string;
  category: string | null;
  cash_price_cents: number;
  card_price_cents: number;
  /** The digits or text to encode, and in which symbology; null = no barcode. */
  barcode: { kind: 'upca' | 'ean13' | 'code128'; data: string } | null;
}

export interface TagContent {
  title: string;
  category: string | null;
  cash: string;
  card: string | null;
  note: string | null;
  barcode: { modules: string; text: string } | null;
}

export function tagContent(item: TagItem, t: LabelTemplateInput): TagContent {
  return {
    title: item.name,
    category: t.show_category ? item.category : null,
    cash: formatUsd(cents(item.cash_price_cents)),
    card: t.show_card_price ? formatUsd(cents(item.card_price_cents)) : null,
    note: t.note,
    barcode: t.show_barcode && item.barcode ? { modules: encodeBarcode(item.barcode.kind, item.barcode.data), text: item.barcode.data } : null,
  };
}

/** Which symbology a stored barcode prints as. */
export function barcodeKind(code: string): 'upca' | 'ean13' | 'code128' {
  if (/^\d{12}$/.test(code) && upcCheckDigit(code.slice(0, 11)) === Number(code[11])) return 'upca';
  if (/^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12])) return 'ean13';
  return 'code128';
}

// --- UPC-A / EAN-13 -------------------------------------------------------------------------------

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((c) => c.replace(/./g, (b) => (b === '0' ? '1' : '0')));
const G = R.map((c) => [...c].reverse().join(''));
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** UPC-A check digit for 11 digits. */
export function upcCheckDigit(d11: string): number {
  const n = [...d11].map(Number);
  const odd = n.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const even = n.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0);
  return (10 - ((odd * 3 + even) % 10)) % 10;
}

export function ean13CheckDigit(d12: string): number {
  const n = [...d12].map(Number);
  const s = n.reduce((acc, v, i) => acc + v * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (s % 10)) % 10;
}

/** 95 modules: guard, six L digits, centre, six R digits, guard. */
export function upcaModules(code: string): string {
  const d = code.length === 11 ? code + upcCheckDigit(code) : code;
  if (!/^\d{12}$/.test(d) || upcCheckDigit(d.slice(0, 11)) !== Number(d[11])) throw new Error(`Not a UPC-A: ${code}`);
  const left = [...d.slice(0, 6)].map((c) => L[Number(c)]).join('');
  const right = [...d.slice(6)].map((c) => R[Number(c)]).join('');
  return `101${left}01010${right}101`;
}

export function ean13Modules(code: string): string {
  const d = code.length === 12 ? code + ean13CheckDigit(code) : code;
  if (!/^\d{13}$/.test(d) || ean13CheckDigit(d.slice(0, 12)) !== Number(d[12])) throw new Error(`Not an EAN-13: ${code}`);
  const parity = EAN_PARITY[Number(d[0])]!;
  const left = [...d.slice(1, 7)].map((c, i) => (parity[i] === 'L' ? L : G)[Number(c)]).join('');
  const right = [...d.slice(7)].map((c) => R[Number(c)]).join('');
  return `101${left}01010${right}101`;
}

// --- Code 128 (set B: printable ASCII) --------------------------------------------------------------

/** Bar/space widths for values 0–106 (106 = stop, 7 elements). */
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

const widthsToModules = (w: string) => [...w].map((n, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(n))).join('');

export function code128Modules(text: string): string {
  if (!/^[\x20-\x7e]{1,40}$/.test(text)) throw new Error('Code 128 labels take 1–40 printable ASCII characters');
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = (START_B + values.reduce((acc, v, i) => acc + v * (i + 1), 0)) % 103;
  return [START_B, ...values, check, STOP].map((v) => widthsToModules(CODE128_PATTERNS[v]!)).join('');
}

export function encodeBarcode(kind: 'upca' | 'ean13' | 'code128', data: string): string {
  return kind === 'upca' ? upcaModules(data) : kind === 'ean13' ? ean13Modules(data) : code128Modules(data);
}

// --- Price-embedded UPC-A (restricted circulation, number system 2) --------------------------------

/** "2" + 5-digit PLU + 5-digit price in cents (up to $999.99) + check digit. */
export function priceEmbeddedUpc(plu: string, priceCents: number): string {
  if (!/^\d{1,5}$/.test(plu)) throw new Error('A price label needs a PLU of up to 5 digits');
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99_999) throw new Error('Price labels go up to $999.99');
  const d11 = `2${plu.padStart(5, '0')}${String(priceCents).padStart(5, '0')}`;
  return d11 + upcCheckDigit(d11);
}

/** A scanned price-embedded UPC-A → the PLU and price; null for any other code. */
export function decodePriceEmbedded(code: string): { plu: string; price_cents: number } | null {
  const t = code.trim();
  const d = /^\d{13}$/.test(t) && t.startsWith('0') ? t.slice(1) : t; // an EAN-13 reader adds a leading 0
  if (!/^2\d{11}$/.test(d) || upcCheckDigit(d.slice(0, 11)) !== Number(d[11])) return null;
  return { plu: String(Number(d.slice(1, 6))), price_cents: Number(d.slice(6, 11)) };
}

/** An in-store UPC-A (number system 4) for an item that has no barcode of its own. */
export function inStoreUpc(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9_999_999_999) throw new Error('Out of in-store codes');
  const d11 = `4${String(sequence).padStart(10, '0')}`;
  return d11 + upcCheckDigit(d11);
}
