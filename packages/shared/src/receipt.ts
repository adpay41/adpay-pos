/**
 * Receipt template — renders a folded sale to fixed-width text lines for an 80mm thermal printer
 * (48 columns in the printer's standard font). The same lines drive the on-screen preview, the
 * printer module (step 2, Kotlin) and reprints, so a reprint is byte-for-byte the original.
 *
 * Receipts are rendered from the sale's events (via foldSale), never from mutable state, so a reprint
 * weeks later shows the prices that were actually charged.
 *
 * Format decision (spec Open: "receipt template format"): plain structured text lines plus a small
 * set of style hints, not ESC/POS bytes. The printer module maps hints to ESC/POS; the web preview
 * maps them to CSS. See docs/decisions/0009-register-core.md.
 */
import type { FoldedSale } from './fold';
import { add, cents, formatUsd, mulQty } from './money';

export const RECEIPT_WIDTH = 48;

export type ReceiptStyle = 'normal' | 'bold' | 'double' | 'center';

export interface ReceiptLine {
  text: string;
  style: ReceiptStyle;
}

export interface ReceiptHeader {
  merchant_name: string;
  location_name: string;
  address_line1: string | null;
  city_state_zip: string | null;
  register_name: string;
}

export interface ReceiptInput {
  header: ReceiptHeader;
  sale: FoldedSale;
  occurred_at: string;
  timezone: string;
  copy: 'original' | 'reprint';
  footer?: string;
}

const money = (v: number) => formatUsd(cents(v));

function pad(left: string, right: string, width = RECEIPT_WIDTH): string {
  const room = width - right.length - 1;
  const l = left.length > room ? left.slice(0, Math.max(0, room - 1)) + '…' : left;
  return l + ' '.repeat(Math.max(1, width - l.length - right.length)) + right;
}

function center(text: string, width = RECEIPT_WIDTH): string {
  const t = text.length > width ? text.slice(0, width) : text;
  const left = Math.floor((width - t.length) / 2);
  return ' '.repeat(left) + t;
}

const rule = (ch = '-') => ch.repeat(RECEIPT_WIDTH);

export function renderReceipt(input: ReceiptInput): ReceiptLine[] {
  const { header, sale } = input;
  const mode = sale.price_mode ?? 'cash';
  const totals = mode === 'card' ? sale.card : sale.cash;
  const out: ReceiptLine[] = [];
  const push = (text: string, style: ReceiptStyle = 'normal') => out.push({ text, style });

  push(center(header.merchant_name), 'double');
  push(center(header.location_name), 'center');
  if (header.address_line1) push(center(header.address_line1), 'center');
  if (header.city_state_zip) push(center(header.city_state_zip), 'center');
  push(rule());

  const when = new Date(input.occurred_at).toLocaleString('en-US', {
    timeZone: input.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  push(pad(when, header.register_name));
  push(pad('Ticket', sale.sale_id.slice(0, 8).toUpperCase()));
  if (input.copy === 'reprint') push(center('*** REPRINT ***'), 'bold');
  push(rule());

  for (const line of sale.lines) {
    const unit = mode === 'card' ? line.unit_card_price_cents : line.unit_cash_price_cents;
    const discount = mode === 'card' ? line.card_discount_cents : line.cash_discount_cents;
    const qtyPrefix = line.qty > 1 ? `${line.qty} x ` : '';
    push(pad(`${qtyPrefix}${line.name}${line.taxable ? '' : ' N'}`, money(mulQty(unit, line.qty))));
    if (line.qty > 1) push(`   @ ${money(unit)} ea`);
    if (discount > 0) push(pad('   Discount', `-${money(discount)}`));
    if (line.min_age) push(`   Age ${line.min_age}+ ${line.age_verified ? 'verified' : 'NOT verified'}`);
  }

  push(rule());
  push(pad('Subtotal', money(totals.subtotal_cents)));
  push(pad('Tax', money(totals.tax_cents)));
  push(pad('TOTAL', money(totals.total_cents)), 'bold');
  push(pad(mode === 'card' ? 'Card price applied' : 'Cash price applied', ''));
  push('');

  for (const t of sale.tenders) {
    if (t.tender_type === 'cash') {
      push(pad('Cash', money(add(t.amount_cents, t.change_cents))));
      push(pad('Change', money(t.change_cents)), 'bold');
    } else {
      push(pad(`Card ${t.approved ? 'APPROVED' : 'DECLINED'}`, money(t.amount_cents)));
    }
  }
  if (sale.status === 'voided') push(center('*** VOID ***'), 'double');
  if (sale.refunded_cents > 0) push(pad('Refunded', `-${money(sale.refunded_cents)}`));

  // Dual-pricing disclosure: both totals, every receipt (NJ/NY posted-pricing).
  push(rule());
  push(pad('Cash price total', money(sale.cash.total_cents)));
  push(pad('Card price total', money(sale.card.total_cents)));
  push('N = not taxable');
  push(rule());
  push(center(input.footer ?? 'Thank you!'), 'center');
  return out;
}

/** Plain text, e.g. for logs, tests and the fallback preview. */
export function receiptText(lines: readonly ReceiptLine[]): string {
  return lines.map((l) => l.text).join('\n');
}
