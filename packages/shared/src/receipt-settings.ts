/**
 * Per-location receipt settings (build plan P8 / F6, Bible 1.6): what goes on the 80mm receipt
 * beyond the sale itself, and what the register does after a sale. They travel in the register's
 * config snapshot, so receipts print the same offline.
 */
import { z } from 'zod';
import { parseRegisterEvent } from './events';
import { foldSale, type FoldedSale } from './fold';
import { cents } from './money';
import { deriveCardPrice } from './pricing';

export const DEFAULT_RETURN_POLICY = 'Returns with receipt within 7 days. No returns on tobacco, lottery or food.';

export const ReceiptSettingsInput = z.strictObject({
  /** Extra header lines under the address: phone, Instagram, "Open 24 hours". */
  header_lines: z.array(z.string().trim().min(1).max(48)).max(4).default([]),
  /** A store logo (a media id from the upload endpoint), printed at the top. */
  logo_media_id: z.uuid().nullable().default(null),
  return_policy: z.string().trim().max(240).nullable().default(DEFAULT_RETURN_POLICY),
  footer: z.string().trim().max(96).default('Thank you!'),
  /**
   * A QR code at the bottom. `link` = a URL the store chooses (review page, Instagram, website).
   * A QR to a digital copy of the receipt needs public hosting (Bible N, build plan P18 ⛔).
   */
  qr: z
    .strictObject({ kind: z.literal('link'), url: z.url().max(300), caption: z.string().trim().max(48).default('Scan me') })
    .nullable()
    .default(null),
  /**
   * After a cash sale: ask each time, always print, or never print unless asked. "never" is the
   * Bible's zero-tap sale: tap Exact and the register is ready for the next customer.
   */
  after_sale: z.enum(['ask', 'print', 'none']).default('ask'),
});
export type ReceiptSettings = z.infer<typeof ReceiptSettingsInput>;

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = ReceiptSettingsInput.parse({});

/**
 * A realistic sale for previewing receipt settings in the editors: two taxable items at the
 * location's rate, one non-taxable, paid in cash. Built from real events and folded, so the preview
 * is exactly what the register would print.
 */
export function sampleReceiptSale(taxRatePpm: number, dualRatePpm: number): FoldedSale {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const t = { org_id: id(1), merchant_id: id(2), location_id: id(3), register_id: id(4) };
  let seq = 0;
  const ev = (type: string, payload: unknown) =>
    parseRegisterEvent({ event_id: id(100 + seq), schema_version: 1, sale_id: id(9), device_seq: seq++, occurred_at: '2026-09-23T12:15:00.000Z', ...t, trace_id: 'preview', type, payload });
  const line = (n: number, name: string, cash: number, qty: number, taxable: boolean) =>
    ev('sale.line_added', {
      line_id: id(20 + n), item_id: id(30 + n), name, category_id: null, qty, unit_cash_price_cents: cash,
      unit_card_price_cents: deriveCardPrice(cents(cash), dualRatePpm), taxable, tax_rate_ppm: taxable ? taxRatePpm : 0, min_age: null,
    });
  const events = [ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }), line(1, 'Bacon, Egg & Cheese', 629, 1, true), line(2, 'Hot Coffee — Large', 275, 2, true), line(3, 'Lottery — Pick 3', 500, 1, false)];
  const open = foldSale(id(9), events);
  events.push(
    ev('sale.tender_added', { tender_id: id(40), tender_type: 'cash', amount_cents: open.cash.total_cents, tendered_cents: 2_000, change_cents: 2_000 - open.cash.total_cents, card: null }),
    ev('sale.completed', { price_mode: 'cash', ...open.cash }),
  );
  return foldSale(id(9), events);
}
