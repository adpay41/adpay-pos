/**
 * Cohorts and the investor / bank pack (Bible 3.5; P25c, ADR 0041). Everything is derived from the
 * ledger on read, like the KPIs (ADR 0022): a store's cohort is the month of its first completed
 * sale; a month's figures are that month's residual report.
 */
import type { Kpis } from '@adpay/shared';
import type { Queryable } from '../db/db';
import { kpis, residualReport } from './money';

export interface CohortMonth {
  offset: number;
  month: string;
  /** Stores of the cohort with at least one sale that month. */
  active: number;
  /** active / cohort size, in tenths of a percent. */
  retention_tenths: number;
  sales_cents: number;
}
export interface Cohort {
  cohort: string;
  stores: number;
  months: CohortMonth[];
}

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const addMonths = (m: string, n: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const tenths = (part: number, whole: number) => (whole ? Math.floor((part * 1000) / whole) : 0);

/** Store cohorts by first-sale month, over the last `months` months (current month included). */
export async function cohorts(q: Queryable, thisMonth: string, months = 12): Promise<Cohort[]> {
  const from = addMonths(thisMonth, -(months - 1));
  const { rows } = await q.query<{ cohort: string; month: string; active: number; sales_cents: string | number }>(
    `WITH firsts AS (
       SELECT merchant_id, to_char(min(business_date), 'YYYY-MM') AS cohort FROM sale_events WHERE type = 'sale.completed' GROUP BY merchant_id),
     monthly AS (
       SELECT merchant_id, to_char(business_date, 'YYYY-MM') AS month, sum((payload->>'total_cents')::bigint) AS sales_cents
         FROM sale_events WHERE type = 'sale.completed' AND business_date >= ($1 || '-01')::date
        GROUP BY 1, 2)
     SELECT f.cohort, m.month, count(*)::int AS active, sum(m.sales_cents) AS sales_cents
       FROM firsts f JOIN monthly m ON m.merchant_id = f.merchant_id
      WHERE f.cohort >= $1
      GROUP BY 1, 2`,
    [from],
  );
  const { rows: sizes } = await q.query<{ cohort: string; stores: number }>(
    `SELECT cohort, count(*)::int AS stores FROM (
       SELECT to_char(min(business_date), 'YYYY-MM') AS cohort FROM sale_events WHERE type = 'sale.completed' GROUP BY merchant_id) f
      WHERE cohort >= $1 GROUP BY cohort ORDER BY cohort`,
    [from],
  );
  return sizes.map((c) => {
    const span = monthsBetween(c.cohort, thisMonth);
    return {
      cohort: c.cohort,
      stores: c.stores,
      months: Array.from({ length: span + 1 }, (_, offset) => {
        const month = addMonths(c.cohort, offset);
        const r = rows.find((x) => x.cohort === c.cohort && x.month === month);
        const active = r?.active ?? 0;
        return { offset, month, active, retention_tenths: tenths(active, c.stores), sales_cents: Number(r?.sales_cents ?? 0) };
      }),
    };
  });
}

export interface PackMonth {
  month: string;
  /** Stores with a first sale on or before the month's end. */
  stores_started: number;
  /** Stores with a sale in the month. */
  stores_active: number;
  sales_cents: number;
  card_volume_cents: number;
  revenue_cents: number;
  subscription_revenue_cents: number;
  processing_revenue_cents: number;
  /** Over stores with the month's processor cost entered; null when none. */
  margin_cents: number | null;
  margin_stores: number;
}

export interface InvestorPack {
  as_of: string;
  kpis: Kpis;
  months: PackMonth[];
  cohorts: Cohort[];
  /** Average retention across cohorts old enough, at 1, 3 and 6 months (tenths of a percent). */
  retention: { m1: number | null; m3: number | null; m6: number | null };
  notes: string[];
}

export async function investorPack(q: Queryable, now = new Date(), months = 12): Promise<InvestorPack> {
  const k = await kpis(q, now);
  const thisMonth = k.month;
  const cs = await cohorts(q, thisMonth, months);
  const { rows: activity } = await q.query<{ month: string; started: number; active: number; sales_cents: string | number }>(
    `WITH firsts AS (SELECT merchant_id, min(business_date) AS first_day FROM sale_events WHERE type = 'sale.completed' GROUP BY merchant_id),
     ms AS (SELECT to_char(generate_series(($1 || '-01')::date, ($2 || '-01')::date, interval '1 month'), 'YYYY-MM') AS month)
     SELECT ms.month,
            (SELECT count(*)::int FROM firsts f WHERE to_char(f.first_day, 'YYYY-MM') <= ms.month) AS started,
            (SELECT count(DISTINCT e.merchant_id)::int FROM sale_events e WHERE e.type = 'sale.completed' AND to_char(e.business_date, 'YYYY-MM') = ms.month) AS active,
            (SELECT coalesce(sum((e.payload->>'total_cents')::bigint), 0) FROM sale_events e WHERE e.type = 'sale.completed' AND to_char(e.business_date, 'YYYY-MM') = ms.month) AS sales_cents
       FROM ms ORDER BY ms.month`,
    [addMonths(thisMonth, -(months - 1)), thisMonth],
  );
  const out: PackMonth[] = [];
  for (const a of activity) {
    const report = await residualReport(q, a.month);
    const withCost = report.filter((r) => r.cost_entered);
    const sum = (f: (r: (typeof report)[number]) => number, rs = report) => rs.reduce((n, r) => n + f(r), 0);
    out.push({
      month: a.month,
      stores_started: a.started,
      stores_active: a.active,
      sales_cents: Number(a.sales_cents),
      card_volume_cents: sum((r) => Math.max(0, r.card_volume_cents)),
      revenue_cents: sum((r) => r.revenue_cents),
      subscription_revenue_cents: sum((r) => r.subscription_revenue_cents),
      processing_revenue_cents: sum((r) => r.processing_revenue_cents),
      margin_cents: withCost.length ? sum((r) => r.margin_cents ?? 0, withCost) : null,
      margin_stores: withCost.length,
    });
  }
  const at = (offset: number) => {
    const eligible = cs.filter((c) => c.months[offset] && c.months[offset].month < thisMonth);
    if (!eligible.length) return null;
    return Math.floor(eligible.reduce((n, c) => n + c.months[offset]!.retention_tenths, 0) / eligible.length);
  };
  return {
    as_of: now.toISOString(),
    kpis: k,
    months: out,
    cohorts: cs,
    retention: { m1: at(1), m3: at(3), m6: at(6) },
    notes: [
      'All figures are derived from the register event ledger on the date shown; nothing is typed in except processor cost.',
      'Revenue follows each store’s pricing plan in force at month end (dual pricing surcharge, IC+ markup or flat rate, plus subscription).',
      'Margin covers only stores whose processor cost for the month is entered (typed by hand until processor data is connected).',
      'Retention counts complete months only: a cohort’s store is retained in a month if it made at least one sale.',
    ],
  };
}

/** The pack's monthly table as CSV (integer cents written as dollars). */
export function investorPackCsv(p: InvestorPack): string {
  const d = (c: number | null) => (c === null ? '' : `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`);
  const lines = ['month,stores_started,stores_active,sales,card_volume,revenue,subscription_revenue,processing_revenue,margin,margin_stores'];
  for (const m of p.months) lines.push([m.month, m.stores_started, m.stores_active, d(m.sales_cents), d(m.card_volume_cents), d(m.revenue_cents), d(m.subscription_revenue_cents), d(m.processing_revenue_cents), d(m.margin_cents), m.margin_stores].join(','));
  return `${lines.join('\n')}\n`;
}
