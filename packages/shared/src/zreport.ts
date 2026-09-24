/**
 * End of day: the Z-report (spec v1 "End of day: cash count, Z-report (by tender, by category,
 * voids/refunds), print + push to server"; build plan P16). ADR 0025.
 *
 * A Z covers **everything on one register since its previous Z**: that is what a Z is (it closes
 * the period). It is built from the events alone, by this one function, on the register (to print)
 * and on the server (to check what the register declared). Spec acceptance: "Z-report cash count
 * matches the sum of cash events for the day": the drawer section is `foldDrawer` of the same events.
 */
import { foldDrawer } from './drawer';
import type { RegisterEvent } from './events';
import { foldSale, lineTotal, toTaxable, type FoldedSale } from './fold';
import { add, cents, formatUsd, sum, ZERO, type Cents } from './money';
import { taxByRate } from './pricing';
import { ppmToPercent } from './catalog';
import { splitTaxGroups } from './split';

export interface ZReport {
  z_number: number;
  register_id: string;
  /** Store-local date the Z was taken. */
  business_date: string;
  from_seq: number;
  to_seq: number;
  first_at: string | null;
  last_at: string | null;
  sales_count: number;
  /** Money taken on completed, not-voided sales (approved tenders). */
  gross_cents: Cents;
  by_tender: { cash_cents: Cents; card_cents: Cents; cash_count: number; card_count: number };
  by_category: { category_id: string | null; name: string; qty: number; amount_cents: Cents }[];
  tax_by_rate: { rate_ppm: number; taxable_cents: Cents; tax_cents: Cents }[];
  tax_cents: Cents;
  refunds: { count: number; cash_cents: Cents; card_cents: Cents };
  voids: number;
  no_sales: number;
  counterfeits: number;
  drawer: { sessions: number; float_cents: Cents; expected_cents: Cents; counted_cents: Cents | null; over_short_cents: Cents | null };
}

/** What the register declares on `eod.closed`; the server re-folds and compares. */
export interface ZTotals {
  sales_count: number;
  gross_cents: number;
  tax_cents: number;
  voids: number;
  cash_cents: number;
  card_cents: number;
  refunds_cents: number;
}

export function zTotals(z: ZReport): ZTotals {
  return {
    sales_count: z.sales_count,
    gross_cents: z.gross_cents,
    tax_cents: z.tax_cents,
    voids: z.voids,
    cash_cents: z.by_tender.cash_cents,
    card_cents: z.by_tender.card_cents,
    refunds_cents: add(z.refunds.cash_cents, z.refunds.card_cents),
  };
}

function taxGroupsOf(s: FoldedSale) {
  if (s.price_mode === 'split' && s.declared) {
    return splitTaxGroups(taxByRate(toTaxable(s.lines, 'cash')), taxByRate(toTaxable(s.lines, 'card')), s.tenders.filter((t) => t.approved), s.cash.total_cents, s.declared.tax_cents);
  }
  return taxByRate(toTaxable(s.lines, s.price_mode === 'card' ? 'card' : 'cash'));
}

/**
 * `events`: this register's events after the previous Z (device_seq > from_seq). A sale that began
 * before the previous Z and finished after it is counted here, where it completed.
 */
export function buildZReport(
  events: readonly RegisterEvent[],
  meta: { z_number: number; register_id: string; business_date: string; from_seq: number; categoryName: (id: string | null) => string },
): ZReport {
  const ordered = [...events].sort((a, b) => a.device_seq - b.device_seq);
  const saleIds = [...new Set(ordered.filter((e) => e.sale_id).map((e) => e.sale_id!))];
  const sales = saleIds.map((id) => foldSale(id, ordered));
  const done = sales.filter((s) => s.status === 'completed');
  // Category per line, from the line events (the fold keeps prices, not categories).
  const lineCategory = new Map<string, string | null>();
  for (const e of ordered) if (e.type === 'sale.line_added') lineCategory.set(e.payload.line_id, e.payload.category_id);
  const cats = new Map<string, { category_id: string | null; name: string; qty: number; amount: Cents[] }>();
  const rates = new Map<number, { taxable: Cents[]; tax: Cents[] }>();
  for (const s of done) {
    const mode = s.price_mode === 'card' ? 'card' : 'cash';
    for (const l of s.lines) {
      const categoryId = lineCategory.get(l.line_id) ?? null;
      const key = l.is_fee ? 'fees' : (categoryId ?? 'none');
      const c = cats.get(key) ?? { category_id: l.is_fee ? null : categoryId, name: l.is_fee ? 'Fees' : meta.categoryName(categoryId), qty: 0, amount: [] };
      c.qty += l.qty;
      c.amount.push(lineTotal(l, mode));
      cats.set(key, c);
    }
    for (const g of taxGroupsOf(s)) {
      const r = rates.get(g.rate_ppm) ?? { taxable: [], tax: [] };
      r.taxable.push(g.taxable_cents);
      r.tax.push(g.tax_cents);
      rates.set(g.rate_ppm, r);
    }
  }
  const tenders = done.flatMap((s) => s.tenders.filter((t) => t.approved));
  const refunds = ordered.filter((e) => e.type === 'sale.refunded');
  const drawer = foldDrawer(ordered).sessions;
  const closed = drawer.filter((d) => d.counted_cents !== null);
  const seqs = ordered.map((e) => e.device_seq);
  const tax_by_rate = [...rates.entries()].sort(([a], [b]) => a - b).map(([rate_ppm, r]) => ({ rate_ppm, taxable_cents: sum(r.taxable), tax_cents: sum(r.tax) }));
  return {
    z_number: meta.z_number,
    register_id: meta.register_id,
    business_date: meta.business_date,
    from_seq: meta.from_seq,
    to_seq: seqs.length ? Math.max(...seqs) : meta.from_seq,
    first_at: ordered[0]?.occurred_at ?? null,
    last_at: ordered[ordered.length - 1]?.occurred_at ?? null,
    sales_count: done.length,
    gross_cents: sum(tenders.map((t) => t.amount_cents)),
    by_tender: {
      cash_cents: sum(tenders.filter((t) => t.tender_type === 'cash').map((t) => t.amount_cents)),
      card_cents: sum(tenders.filter((t) => t.tender_type === 'card').map((t) => t.amount_cents)),
      cash_count: tenders.filter((t) => t.tender_type === 'cash').length,
      card_count: tenders.filter((t) => t.tender_type === 'card').length,
    },
    by_category: [...cats.values()].map((c) => ({ category_id: c.category_id, name: c.name, qty: c.qty, amount_cents: sum(c.amount) })).sort((a, b) => b.amount_cents - a.amount_cents),
    tax_by_rate,
    tax_cents: sum(tax_by_rate.map((r) => r.tax_cents)),
    refunds: {
      count: refunds.length,
      cash_cents: sum(refunds.filter((e) => e.type === 'sale.refunded' && e.payload.tender_type === 'cash').map((e) => cents((e.payload as { amount_cents: number }).amount_cents))),
      card_cents: sum(refunds.filter((e) => e.type === 'sale.refunded' && e.payload.tender_type === 'card').map((e) => cents((e.payload as { amount_cents: number }).amount_cents))),
    },
    voids: ordered.filter((e) => e.type === 'sale.voided').length,
    no_sales: ordered.filter((e) => e.type === 'drawer.opened' && e.payload.reason === 'manual').length,
    counterfeits: ordered.filter((e) => e.type === 'drawer.counterfeit').length,
    drawer: {
      sessions: drawer.length,
      float_cents: sum(drawer.map((d) => d.float_cents)),
      expected_cents: sum(drawer.map((d) => d.expected_cents)),
      counted_cents: closed.length ? sum(closed.map((d) => d.counted_cents!)) : null,
      over_short_cents: closed.length ? sum(closed.map((d) => d.over_short_cents!)) : null,
    },
  };
}

/** The printed Z: 48 columns like the receipt. */
export function renderZReport(z: ZReport, header: { merchant_name: string; location_name: string; register_name: string; timezone: string }, opts: { training?: boolean } = {}): string[] {
  const W = 48;
  const money = (c: number) => formatUsd(cents(c));
  const pad = (l: string, r: string) => (l.length + r.length + 1 > W ? `${l.slice(0, W - r.length - 2)}… ${r}` : `${l}${' '.repeat(W - l.length - r.length)}${r}`);
  const rule = '-'.repeat(W);
  const center = (t: string) => ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: header.timezone, dateStyle: 'short', timeStyle: 'short' }) : '—');
  const out = [center(header.merchant_name), center(header.location_name), center(`Z-REPORT #${z.z_number}`), ...(opts.training ? [center('*** TRAINING ***')] : []), pad(header.register_name, z.business_date), pad('From', when(z.first_at)), pad('To', when(z.last_at)), rule];
  out.push(pad(`Sales (${z.sales_count})`, money(z.gross_cents)));
  out.push(pad(`  Cash (${z.by_tender.cash_count})`, money(z.by_tender.cash_cents)));
  out.push(pad(`  Card (${z.by_tender.card_count})`, money(z.by_tender.card_cents)));
  out.push(rule, 'BY CATEGORY');
  for (const c of z.by_category) out.push(pad(`  ${c.name} (${c.qty})`, money(c.amount_cents)));
  out.push(rule, 'TAX');
  if (z.tax_by_rate.length === 0) out.push(pad('  No taxable sales', money(0)));
  for (const r of z.tax_by_rate) out.push(pad(`  ${ppmToPercent(r.rate_ppm)}% on ${money(r.taxable_cents)}`, money(r.tax_cents)));
  out.push(pad('Tax total', money(z.tax_cents)));
  out.push(rule);
  out.push(pad(`Refunds (${z.refunds.count})`, money(add(z.refunds.cash_cents, z.refunds.card_cents))));
  out.push(pad('Voids', String(z.voids)), pad('No-sale opens', String(z.no_sales)), pad('Counterfeits refused', String(z.counterfeits)));
  out.push(rule, 'CASH DRAWER');
  out.push(pad('  Float', money(z.drawer.float_cents)), pad('  Expected', money(z.drawer.expected_cents)));
  out.push(pad('  Counted', z.drawer.counted_cents === null ? 'not counted' : money(z.drawer.counted_cents)));
  if (z.drawer.over_short_cents !== null) out.push(pad(z.drawer.over_short_cents < 0 ? '  Short' : '  Over', money(Math.abs(z.drawer.over_short_cents))));
  out.push(rule, center(`Printed ${when(new Date().toISOString())}`));
  return out;
}

export const EMPTY_Z_TOTALS: ZTotals = { sales_count: 0, gross_cents: ZERO, tax_cents: ZERO, voids: 0, cash_cents: 0, card_cents: 0, refunds_cents: 0 };
