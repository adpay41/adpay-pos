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
import { cellWidth, sliceCells, translator, type Lang, type Overrides } from './i18n';
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
  /**
   * Receipt language (P18). Absent = the language captured on the sale, else English. Store-written
   * text (header lines, return policy, footer) and item names print as the store wrote them.
   */
  lang?: Lang;
  overrides?: Overrides;
  /** The digital copy's URL (P18): printed as a QR when the sale has a receipt token. */
  digital_url?: string | null;
}

const money = (v: number) => formatUsd(cents(v));

// Widths are in printer columns, not characters: CJK takes two, combining marks none (P18).
function pad(left: string, right: string, width = RECEIPT_WIDTH): string {
  const room = width - cellWidth(right) - 1;
  const l = cellWidth(left) > room ? sliceCells(left, Math.max(0, room - 1)) + '…' : left;
  return l + ' '.repeat(Math.max(1, width - cellWidth(l) - cellWidth(right))) + right;
}

function center(text: string, width = RECEIPT_WIDTH): string {
  const t = cellWidth(text) > width ? sliceCells(text, width) : text;
  const left = Math.floor((width - cellWidth(t)) / 2);
  return ' '.repeat(left) + t;
}

const rule = (ch = '-') => ch.repeat(RECEIPT_WIDTH);

/** Word-wrap to the paper width (long words, and unspaced CJK, are cut; never overflow). */
export function wrap(text: string, width = RECEIPT_WIDTH): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w.length; ) {
      const piece = sliceCells(w, width) || [...w][0]!;
      w = w.slice(piece.length);
      if (!cur) cur = piece;
      else if (cellWidth(cur) + 1 + cellWidth(piece) <= width) cur += ` ${piece}`;
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
  const t = translator(input.lang ?? sale.language ?? 'en', input.overrides);

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
  push(pad(t('r_ticket'), sale.sale_id.slice(0, 8).toUpperCase()));
  if (input.copy === 'reprint') push(center(t('r_reprint')), 'bold');
  push(rule());

  for (const line of sale.lines) {
    const unit = mode === 'card' ? line.unit_card_price_cents : line.unit_cash_price_cents;
    const discount = mode === 'card' ? line.card_discount_cents : line.cash_discount_cents;
    const qtyPrefix = line.qty > 1 ? `${line.qty} x ` : '';
    push(pad(`${qtyPrefix}${line.name}${line.taxable ? '' : ' N'}`, money(mulQty(unit, line.qty))));
    if (line.qty > 1) push(`   ${t('r_each', { price: money(unit) })}`);
    if (discount > 0) push(pad(`   ${t('r_discount')}`, `-${money(discount)}`));
    // Per-unit charges (P10): deposit, excise, fee, each on its own line under the item.
    for (const c of line.charges) {
      const each = cents(mode === 'card' ? c.unit_card_cents : c.unit_cash_cents);
      push(pad(`   ${c.label}${line.qty > 1 ? ` ${line.qty} x ${money(each)}` : ''}`, money(mulQty(each, line.qty))));
    }
    if (line.min_age) push(`   ${t(line.age_verified ? 'r_age_verified' : 'r_age_not_verified', { age: line.min_age })}`);
  }

  push(rule());
  push(pad(t('r_subtotal'), money(totals.subtotal_cents)));
  // Tax itemized by rate (Bible 1.6), one line per rate; they add up to the total tax exactly.
  const groupsAt = (m: 'cash' | 'card') => taxByRate(toTaxable(sale.lines, m));
  const groups =
    sale.price_mode === 'split'
      ? splitTaxGroups(
          groupsAt('cash'),
          groupsAt('card'),
          sale.tenders.filter((x) => x.approved),
          sale.cash.total_cents,
          totals.tax_cents,
        )
      : groupsAt(mode);
  if (groups.length === 0) push(pad(t('r_tax'), money(totals.tax_cents)));
  for (const g of groups) push(pad(t('r_tax_rate', { rate: ppmToPercent(g.rate_ppm), amount: money(g.taxable_cents) }), money(g.tax_cents)));
  push(pad(t('r_total'), money(totals.total_cents)), 'bold');
  push(
    pad(
      t(sale.price_mode === 'split' ? 'r_split_applied' : mode === 'card' ? 'r_card_applied' : 'r_cash_applied'),
      '',
    ),
  );
  push('');

  for (const tender of sale.tenders) {
    if (tender.tender_type === 'cash') {
      push(pad(t('r_cash'), money(add(tender.amount_cents, tender.change_cents))));
      push(pad(t('r_change'), money(tender.change_cents)), 'bold');
    } else {
      // Brand and last four only: the only card facts we ever hold (CLAUDE.md rule 3).
      const card = tender.card ? `${(tender.card.brand ?? t('r_card')).toUpperCase()} ****${tender.card.last4 ?? '----'}` : t('r_card');
      push(pad(`${card} ${t(tender.approved ? 'r_approved' : 'r_declined')}`, money(tender.amount_cents)));
      if (tender.approved && tender.card?.approval_code) push(`   ${t('r_auth', { code: tender.card.approval_code })}`);
    }
  }
  if (sale.status === 'voided') push(center(t('r_void')), 'double');
  if (sale.refunded_cents > 0) push(pad(t('r_refunded'), `-${money(sale.refunded_cents)}`));

  // Dual-pricing disclosure: both totals, every receipt (NJ/NY posted-pricing).
  push(rule());
  push(pad(t('r_cash_total'), money(sale.cash.total_cents)));
  push(pad(t('r_card_total'), money(sale.card.total_cents)));
  push(t('r_not_taxable'));
  push(rule());
  const policy = settings === undefined ? null : settings.return_policy;
  if (policy) {
    for (const l of wrap(policy)) push(l);
    push(rule());
  }
  // The digital copy (P18): a QR to the receipt page, when the sale carries a token.
  if (input.digital_url && sale.receipt_token) {
    out.push({ text: center(t('r_digital')), style: 'qr', data: input.digital_url });
    push(center(t('r_digital')), 'center');
  }
  if (settings?.qr) {
    out.push({ text: center(settings.qr.caption), style: 'qr', data: settings.qr.url });
    push(center(settings.qr.caption), 'center');
  }
  // The default footer is ours to translate; a footer the store wrote prints as written.
  const footer = input.footer ?? settings?.footer ?? 'Thank you!';
  push(center(footer === 'Thank you!' ? t('r_thanks') : footer), 'center');
  return out;
}

/** Plain text, e.g. for logs, tests and the fallback preview. */
export function receiptText(lines: readonly ReceiptLine[]): string {
  return lines.map((l) => l.text).join('\n');
}
