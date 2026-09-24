/**
 * Sales-tax report and compliance log (build plan P16b, Bible 2.2 "sales tax report, exportable;
 * quarterly filing pack", 1.4 "compliance log export"). ADR 0026. Computed from folded sales, so the
 * figures are the receipts' figures. Integer cents throughout.
 */
import type { FoldedSale } from './fold';
import { toTaxable } from './fold';
import { cents, sum, type Cents } from './money';
import { taxByRate, type TaxableLine } from './pricing';
import { splitTaxGroups } from './split';
import { ppmToPercent } from './catalog';

export interface RateLine {
  rate_ppm: number;
  taxable_cents: number;
  tax_cents: number;
}

/** Tax groups exactly as the sale's receipt shows them (split sales blended, ADR 0017). */
export function saleTaxGroups(s: FoldedSale): RateLine[] {
  if (s.price_mode === 'split' && s.declared) {
    return splitTaxGroups(taxByRate(toTaxable(s.lines, 'cash')), taxByRate(toTaxable(s.lines, 'card')), s.tenders.filter((t) => t.approved), s.cash.total_cents, s.declared.tax_cents);
  }
  return taxByRate(toTaxable(s.lines, s.price_mode === 'card' ? 'card' : 'cash'));
}

/** Subtotal the customer paid on (before tax), in the sale's mode. */
export function saleSubtotal(s: FoldedSale): Cents {
  if (s.price_mode === 'split' && s.declared) return s.declared.subtotal_cents;
  return s.price_mode === 'card' ? s.card.subtotal_cents : s.cash.subtotal_cents;
}

/** Deposits and per-unit fees inside a sale (P10), and bag-fee lines. */
export function saleCharges(s: FoldedSale): Cents {
  const mode = s.price_mode === 'card' ? 'card' : 'cash';
  return cents(
    s.lines.reduce((n, l) => n + (l.is_fee ? l.qty * (mode === 'card' ? l.unit_card_price_cents : l.unit_cash_price_cents) : 0) + l.charges.reduce((m, c) => m + (mode === 'card' ? c.unit_card_cents : c.unit_cash_cents) * l.qty, 0), 0),
  );
}

/** Tax inside a refund of some lines (units), at the sale's mode, discount spread like refunds do. */
export function refundTax(s: FoldedSale, lines: readonly { line_id: string; qty: number }[]): Cents {
  const mode = s.price_mode === 'card' ? 'card' : 'cash';
  const taxable: TaxableLine[] = [];
  for (const r of lines) {
    const l = s.lines.find((x) => x.line_id === r.line_id);
    if (!l) continue;
    const disc = mode === 'card' ? l.card_discount_cents : l.cash_discount_cents;
    taxable.push({
      qty: r.qty,
      unit_price_cents: mode === 'card' ? l.unit_card_price_cents : l.unit_cash_price_cents,
      discount_cents: Math.ceil((disc * r.qty) / l.qty),
      taxable: l.taxable,
      tax_rate_ppm: l.tax_rate_ppm,
      charges: l.charges.map((c) => ({ unit_cents: mode === 'card' ? c.unit_card_cents : c.unit_cash_cents, taxable: c.taxable })),
    });
  }
  return sum(taxByRate(taxable).map((g) => g.tax_cents));
}

export interface SalesTaxPeriod {
  /** YYYY-MM for a month row, or the whole range. */
  period: string;
  sales_count: number;
  gross_sales_cents: number;
  taxable_cents: number;
  non_taxable_cents: number;
  tax_cents: number;
  by_rate: RateLine[];
  /** Deposits and fees included in gross sales (not sales tax; listed for the filing). */
  deposits_fees_cents: number;
  refunds_cents: number;
  refunds_tax_cents: number;
  /** tax − tax refunded: what the period owes, before the accountant's adjustments. */
  net_tax_cents: number;
}

export interface SalesTaxReport {
  from: string;
  to: string;
  location_name: string | null;
  total: SalesTaxPeriod;
  by_month: SalesTaxPeriod[];
}

export function salesTaxCsv(r: SalesTaxReport): string {
  const money = (c: number) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
  const rates = [...new Set([r.total, ...r.by_month].flatMap((p) => p.by_rate.map((x) => x.rate_ppm)))].sort((a, b) => a - b);
  const head = ['Period', 'Sales', 'Gross sales', 'Taxable', 'Non-taxable', ...rates.flatMap((x) => [`Taxable @${ppmToPercent(x)}%`, `Tax @${ppmToPercent(x)}%`]), 'Tax collected', 'Deposits & fees', 'Refunds', 'Tax refunded', 'Net tax'];
  const row = (p: SalesTaxPeriod) => {
    const at = (rate: number) => p.by_rate.find((x) => x.rate_ppm === rate);
    return [p.period, String(p.sales_count), money(p.gross_sales_cents), money(p.taxable_cents), money(p.non_taxable_cents), ...rates.flatMap((x) => [money(at(x)?.taxable_cents ?? 0), money(at(x)?.tax_cents ?? 0)]), money(p.tax_cents), money(p.deposits_fees_cents), money(p.refunds_cents), money(p.refunds_tax_cents), money(p.net_tax_cents)].join(',');
  };
  return [head.join(','), ...r.by_month.map(row), row(r.total)].join('\n') + '\n';
}

export interface ComplianceEntry {
  at: string;
  register_name: string;
  cashier_name: string | null;
  item_name: string;
  restriction: string | null;
  min_age: number | null;
  method: 'manual' | 'id_scan';
  /** Age from the ID scan; null for a manual check. */
  scanned_age: number | null;
  jurisdiction: string | null;
  sale_id: string;
}

export function complianceCsv(rows: readonly ComplianceEntry[]): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = 'Date & time,Register,Cashier,Item,Restriction,Minimum age,Check,Age on ID,ID state,Ticket';
  return [head, ...rows.map((r) => [r.at, q(r.register_name), q(r.cashier_name ?? ''), q(r.item_name), r.restriction ?? '', r.min_age ?? '', r.method === 'id_scan' ? 'ID scanned' : 'Checked by eye', r.scanned_age ?? '', r.jurisdiction ?? '', r.sale_id.slice(0, 8).toUpperCase()].join(','))].join('\n') + '\n';
}
