/**
 * Sales-tax report (quarterly filing pack) and compliance log (build plan P16b, ADR 0026). Both are
 * folded from the event log at read time, with the same shared functions the receipts use.
 */
import {
  RegisterEventSchema,
  foldSale,
  refundTax,
  saleCharges,
  saleSubtotal,
  saleTaxGroups,
  type ComplianceEntry,
  type RegisterEvent,
  type SalesTaxPeriod,
  type SalesTaxReport,
} from '@adpay/shared';
import type { Queryable } from '../db/db';

type Row = Record<string, unknown> & { occurred_at: Date | string; business_date: string };
const ENVELOPE = `e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id,
                  e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload`;

function period(): SalesTaxPeriod {
  return { period: '', sales_count: 0, gross_sales_cents: 0, taxable_cents: 0, non_taxable_cents: 0, tax_cents: 0, by_rate: [], deposits_fees_cents: 0, refunds_cents: 0, refunds_tax_cents: 0, net_tax_cents: 0 };
}

export async function salesTaxReport(q: Queryable, merchantId: string, from: string, to: string, locationId: string | null = null): Promise<SalesTaxReport> {
  // Every event of every sale that completed or was refunded in the range (a refund of an earlier
  // sale needs that sale's lines to know its tax).
  const { rows } = await q.query<Row>(
    `SELECT ${ENVELOPE}, to_char(e.business_date, 'YYYY-MM-DD') AS business_date
       FROM sale_events e
      WHERE e.merchant_id = $1 AND ($4::uuid IS NULL OR e.location_id = $4::uuid)
        AND e.sale_id IN (SELECT x.sale_id FROM sale_events x
                           WHERE x.merchant_id = $1 AND x.type IN ('sale.completed', 'sale.refunded')
                             AND x.business_date BETWEEN $2::date AND $3::date)
      ORDER BY e.sale_id, e.device_seq`,
    [merchantId, from, to, locationId],
  );
  const bySale = new Map<string, { events: RegisterEvent[]; dates: Map<string, string> }>();
  for (const r of rows) {
    const { business_date, ...env } = r;
    const e = RegisterEventSchema.parse({ ...env, occurred_at: new Date(r.occurred_at).toISOString() });
    const g = bySale.get(e.sale_id!) ?? { events: [] as RegisterEvent[], dates: new Map<string, string>() };
    g.events.push(e);
    g.dates.set(e.event_id, business_date);
    bySale.set(e.sale_id!, g);
  }

  const months = new Map<string, SalesTaxPeriod>();
  const total = period();
  total.period = `${from} – ${to}`;
  const bucket = (date: string) => {
    const k = date.slice(0, 7);
    const p = months.get(k) ?? { ...period(), period: k };
    months.set(k, p);
    return p;
  };
  const addRates = (p: SalesTaxPeriod, groups: { rate_ppm: number; taxable_cents: number; tax_cents: number }[]) => {
    for (const g of groups) {
      const r = p.by_rate.find((x) => x.rate_ppm === g.rate_ppm);
      if (r) {
        r.taxable_cents += g.taxable_cents;
        r.tax_cents += g.tax_cents;
      } else p.by_rate.push({ ...g });
    }
    p.by_rate.sort((a, b) => a.rate_ppm - b.rate_ppm);
  };
  const inRange = (d: string) => d >= from && d <= to;

  for (const [saleId, g] of bySale) {
    const s = foldSale(saleId, g.events);
    const completed = g.events.find((e) => e.type === 'sale.completed');
    const completedDate = completed ? g.dates.get(completed.event_id)! : null;
    // A voided sale's money went back through its refund events; it is not a sale.
    if (s.status === 'completed' && completedDate && inRange(completedDate)) {
      const groups = saleTaxGroups(s);
      const taxable = groups.reduce((n, x) => n + x.taxable_cents, 0);
      const tax = groups.reduce((n, x) => n + x.tax_cents, 0);
      const gross = saleSubtotal(s);
      for (const p of [total, bucket(completedDate)]) {
        p.sales_count++;
        p.gross_sales_cents += gross;
        p.taxable_cents += taxable;
        p.non_taxable_cents += gross - taxable;
        p.tax_cents += tax;
        p.deposits_fees_cents += saleCharges(s);
        addRates(p, groups);
      }
    }
    for (const e of g.events) {
      if (e.type !== 'sale.refunded') continue;
      const d = g.dates.get(e.event_id)!;
      if (!inRange(d) || s.price_mode === null) continue;
      // A void of a completed sale refunds everything; its tax is refunded with it.
      const voidedCompleted = s.status === 'voided' && completedDate !== null;
      if (s.status === 'voided' && !voidedCompleted) continue;
      const rtax = e.payload.lines.length ? refundTax(s, e.payload.lines) : 0;
      for (const p of [total, bucket(d)]) {
        p.refunds_cents += e.payload.amount_cents;
        p.refunds_tax_cents += rtax;
      }
    }
  }
  const all = [...months.values(), total];
  for (const p of all) p.net_tax_cents = p.tax_cents - p.refunds_tax_cents;
  const { rows: loc } = locationId ? await q.query<{ name: string }>('SELECT name FROM locations WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId]) : { rows: [] };
  return { from, to, location_name: loc[0]?.name ?? null, total, by_month: [...months.values()].sort((a, b) => a.period.localeCompare(b.period)) };
}

export async function complianceLog(q: Queryable, merchantId: string, from: string, to: string): Promise<ComplianceEntry[]> {
  const { rows } = await q.query<{
    occurred_at: Date;
    register_name: string;
    cashier_name: string | null;
    sale_id: string;
    payload: { line_id: string; method: 'manual' | 'id_scan'; id_check?: { age: number; jurisdiction: string | null } | null };
    item_name: string | null;
    restriction: string | null;
    min_age: number | null;
  }>(
    `SELECT a.occurred_at, r.name AS register_name, u.name AS cashier_name, a.sale_id, a.payload,
            l.payload->>'name' AS item_name, l.payload->>'restriction' AS restriction, (l.payload->>'min_age')::int AS min_age
       FROM sale_events a
       JOIN registers r ON r.register_id = a.register_id
       LEFT JOIN users u ON u.user_id = coalesce((a.payload->>'verified_by_user_id')::uuid, a.actor_user_id)
       LEFT JOIN sale_events l ON l.sale_id = a.sale_id AND l.type = 'sale.line_added' AND l.payload->>'line_id' = a.payload->>'line_id'
      WHERE a.merchant_id = $1 AND a.type = 'sale.age_verified' AND a.business_date BETWEEN $2::date AND $3::date
      ORDER BY a.occurred_at`,
    [merchantId, from, to],
  );
  return rows.map((r) => ({
    at: new Date(r.occurred_at).toISOString(),
    register_name: r.register_name,
    cashier_name: r.cashier_name,
    item_name: r.item_name ?? 'Item',
    restriction: r.restriction,
    min_age: r.min_age,
    method: r.payload.method,
    scanned_age: r.payload.id_check?.age ?? null,
    jurisdiction: r.payload.id_check?.jurisdiction ?? null,
    sale_id: r.sale_id,
  }));
}
