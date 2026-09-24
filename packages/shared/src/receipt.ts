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
import { ppmToPercent } from './catalog';
import { toTaxable, type FoldedSale } from './fold';
import { add, cents, formatUsd, mulQty } from './money';
import { taxByRate } from './pricing';
import { splitTaxGroups } from './split';
import type { ReceiptSettings } from './receipt-settings';

export const RECEIPT_WIDTH = 48;

export type ReceiptStyle = 'normal' | 'bold' | 'double' | 'center';

/**
 * One printed line. Text lines carry a style hint. Two special lines (P8) carry what the printer
 * module renders as an image: the store logo (a bitmap) and a QR code (ESC/POS has a native QR
 * command). Every line keeps `text` as its plain-text fallback, so text previews and logs still work.
 */
export type ReceiptLine =
  | { text: string; style: ReceiptStyle }
  | { text: string; style: 'logo'; url: string }
  | { text: string; style: 'qr'; data: string };

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
  /** Overrides the settings footer for this print (e.g. "REFUND - $2.12 returned"). */
  footer?: string;
  /** Per-location receipt settings (P8). Absent = the defaults. */
  settings?: ReceiptSettings;
  /** Absolute URL of the logo image when the settings name one. */
  logo_url?: string | null;
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

/** Word-wrap to the paper width (long words are cut, never overflow). */
export function wrap(text: string, width = RECEIPT_WIDTH): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w.length; w = w.slice(width)) {
      const piece = w.slice(0, width);
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= width) cur += ` ${piece}`;
      else {
        out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function renderReceipt(input: ReceiptInput): ReceiptLine[] {
  const { header, sale } = input;
  // A split sale lists items at the cash price and totals what was actually paid (ADR 0017).
  const mode = sale.price_mode === 'card' ? 'card' : 'cash';
  const totals = sale.price_mode === 'split' && sale.declared ? sale.declared : mode === 'card' ? sale.card : sale.cash;
  const out: ReceiptLine[] = [];
  const push = (text: string, style: ReceiptStyle = 'normal') => out.push({ text, style });

  const settings = input.settings;
  if (settings?.logo_media_id && input.logo_url) out.push({ text: center(header.merchant_name), style: 'logo', url: input.logo_url });
  push(center(header.merchant_name), 'double');
  push(center(header.location_name), 'center');
  if (header.address_line1) push(center(header.address_line1), 'center');
  if (header.city_state_zip) push(center(header.city_state_zip), 'center');
  for (const h of settings?.header_lines ?? []) push(center(h), 'center');
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
    // Per-unit charges (P10): deposit, excise, fee, each on its own line under the item.
    for (const c of line.charges) {
      const each = cents(mode === 'card' ? c.unit_card_cents : c.unit_cash_cents);
      push(pad(`   ${c.label}${line.qty > 1 ? ` ${line.qty} x ${money(each)}` : ''}`, money(mulQty(each, line.qty))));
    }
    if (line.min_age) push(`   Age ${line.min_age}+ ${line.age_verified ? 'verified' : 'NOT verified'}`);
  }

  push(rule());
  push(pad('Subtotal', money(totals.subtotal_cents)));
  // Tax itemized by rate (Bible 1.6), one line per rate; they add up to the total tax exactly.
  const groupsAt = (m: 'cash' | 'card') => taxByRate(toTaxable(sale.lines, m));
  const groups =
    sale.price_mode === 'split'
      ? splitTaxGroups(
          groupsAt('cash'),
          groupsAt('card'),
          sale.tenders.filter((t) => t.approved),
          sale.cash.total_cents,
          totals.tax_cents,
        )
      : groupsAt(mode);
  if (groups.length === 0) push(pad('Tax', money(totals.tax_cents)));
  for (const g of groups) push(pad(`Tax ${ppmToPercent(g.rate_ppm)}% on ${money(g.taxable_cents)}`, money(g.tax_cents)));
  push(pad('TOTAL', money(totals.total_cents)), 'bold');
  push(
    pad(
      sale.price_mode === 'split' ? 'Split: cash price on cash part' : mode === 'card' ? 'Card price applied' : 'Cash price applied',
      '',
    ),
  );
  push('');

  for (const t of sale.tenders) {
    if (t.tender_type === 'cash') {
      push(pad('Cash', money(add(t.amount_cents, t.change_cents))));
      push(pad('Change', money(t.change_cents)), 'bold');
    } else {
      // Brand and last four only: the only card facts we ever hold (CLAUDE.md rule 3).
      const card = t.card ? `${(t.card.brand ?? 'Card').toUpperCase()} ****${t.card.last4 ?? '----'}` : 'Card';
      push(pad(`${card} ${t.approved ? 'APPROVED' : 'DECLINED'}`, money(t.amount_cents)));
      if (t.approved && t.card?.approval_code) push(`   Auth ${t.card.approval_code}`);
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
  const policy = settings === undefined ? null : settings.return_policy;
  if (policy) {
    for (const l of wrap(policy)) push(l);
    push(rule());
  }
  if (settings?.qr) {
    out.push({ text: center(settings.qr.caption), style: 'qr', data: settings.qr.url });
    push(center(settings.qr.caption), 'center');
  }
  push(center(input.footer ?? settings?.footer ?? 'Thank you!'), 'center');
  return out;
}

/** Plain text, e.g. for logs, tests and the fallback preview. */
export function receiptText(lines: readonly ReceiptLine[]): string {
  return lines.map((l) => l.text).join('\n');
}
