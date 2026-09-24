/**
 * Reporting — every number here is derived from the immutable event log at read time. Nothing is
 * pre-aggregated and edited. A sale counts when its `sale.completed` falls in range and it has no
 * `sale.voided`; money counted is approved tender, so the figures reconcile with the drawer.
 *
 * Shape: one scan of the window's events (index on merchant_id, business_date), grouped per sale,
 * then summed here with the shared integer money helpers. No correlated lookups across partitions.
 */
import { cents, sum, type SaleListRow, type SalesSummary } from '@adpay/shared';
import type { Queryable } from '../db/db';

type Range = SalesSummary['range'];

interface SaleRow {
  sale_id: string;
  register_id: string;
  register_name: string;
  completed_in_range: boolean;
  voided: boolean;
  hour: number | null;
  cash_cents: number;
  card_cents: number;
  tax_cents: number;
  refunds_cents: number;
  voids_in_range: number;
}

export async function salesSummary(
  q: Queryable,
  merchantId: string,
  range: Range,
  locationId: string | null = null,
): Promise<SalesSummary> {
  const { rows: win } = await q.query<{ d_from: string; d_to: string }>(
    `WITH t AS (
       SELECT (now() AT TIME ZONE coalesce(
         (SELECT timezone FROM locations WHERE merchant_id = $1 ORDER BY created_at LIMIT 1), 'America/New_York'))::date AS today)
     SELECT to_char(CASE $2::text WHEN 'today' THEN today WHEN 'week' THEN today - 6
                                  ELSE date_trunc('month', today)::date END, 'YYYY-MM-DD') AS d_from,
            to_char(today, 'YYYY-MM-DD') AS d_to
       FROM t`,
    [merchantId, range],
  );
  const { d_from, d_to } = win[0]!;

  // A sale's events share a business date except across midnight, so the scan starts a day early
  // and each figure then applies its own in-range test.
  const { rows } = await q.query<SaleRow>(
    `SELECT e.sale_id, e.register_id, r.name || ' · ' || l.name AS register_name,
            bool_or(e.type = 'sale.completed' AND e.business_date BETWEEN $2::date AND $3::date) AS completed_in_range,
            bool_or(e.type = 'sale.voided') AS voided,
            max(extract(hour FROM e.occurred_at AT TIME ZONE l.timezone)::int) FILTER (WHERE e.type = 'sale.completed') AS hour,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (
              WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'cash'), 0)::bigint AS cash_cents,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (
              WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'card'
                AND e.payload->'card'->>'status' = 'approved'), 0)::bigint AS card_cents,
            coalesce(max((e.payload->>'tax_cents')::bigint) FILTER (WHERE e.type = 'sale.completed'), 0)::bigint AS tax_cents,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (
              WHERE e.type = 'sale.refunded' AND e.business_date BETWEEN $2::date AND $3::date), 0)::bigint AS refunds_cents,
            count(*) FILTER (WHERE e.type = 'sale.voided' AND e.business_date BETWEEN $2::date AND $3::date) AS voids_in_range
       FROM sale_events e
       JOIN registers r ON r.register_id = e.register_id
       JOIN locations l ON l.location_id = e.location_id
      WHERE e.merchant_id = $1
        AND e.business_date BETWEEN $2::date - 1 AND $3::date
        AND e.sale_id IS NOT NULL
        AND ($4::uuid IS NULL OR e.location_id = $4::uuid)
      GROUP BY e.sale_id, e.register_id, r.name, l.name`,
    [merchantId, d_from, d_to, locationId],
  );

  const counted = rows.filter((r) => r.completed_in_range && !r.voided);
  const money = (r: SaleRow) => sum([cents(r.cash_cents), cents(r.card_cents)]);

  const byTender = (['card', 'cash'] as const)
    .map((tender_type) => {
      const withTender = counted.filter((r) => (tender_type === 'cash' ? r.cash_cents : r.card_cents) > 0);
      return {
        tender_type,
        amount_cents: sum(withTender.map((r) => cents(tender_type === 'cash' ? r.cash_cents : r.card_cents))),
        count: withTender.length,
      };
    })
    .filter((t) => t.count > 0);

  const hours = new Map<number, SaleRow[]>();
  const registers = new Map<string, SaleRow[]>();
  for (const r of counted) {
    if (r.hour !== null) hours.set(r.hour, [...(hours.get(r.hour) ?? []), r]);
    registers.set(r.register_id, [...(registers.get(r.register_id) ?? []), r]);
  }

  return {
    range,
    from: d_from,
    to: d_to,
    sale_count: counted.length,
    gross_cents: sum(counted.map(money)),
    tax_cents: sum(counted.map((r) => cents(r.tax_cents))),
    refunds_cents: sum(rows.map((r) => cents(r.refunds_cents))),
    voids: rows.reduce((n, r) => n + r.voids_in_range, 0),
    by_tender: byTender,
    by_hour: [...hours.entries()]
      .sort(([a], [b]) => a - b)
      .map(([hour, rs]) => ({ hour, amount_cents: sum(rs.map(money)), count: rs.length })),
    by_register: [...registers.values()]
      .map((rs) => ({
        register_id: rs[0]!.register_id,
        register_name: rs[0]!.register_name,
        amount_cents: sum(rs.map(money)),
        count: rs.length,
      }))
      .sort((a, b) => b.amount_cents - a.amount_cents),
  };
}

/** Most recent tickets. `merchantId` null = admin, across all merchants. */
export async function recentSales(q: Queryable, merchantId: string | null, limit = 50): Promise<SaleListRow[]> {
  const { rows } = await q.query<Omit<SaleListRow, 'occurred_at'> & { occurred_at: Date | string }>(
    `WITH latest AS (
       SELECT sale_id FROM sale_events
        WHERE type = 'sale.opened' AND ($1::uuid IS NULL OR merchant_id = $1::uuid)
        ORDER BY occurred_at DESC LIMIT $2
     )
     SELECT e.sale_id, e.register_id, r.name AS register_name, l.name AS location_name,
            min(e.occurred_at) AS occurred_at,
            CASE WHEN bool_or(e.type = 'sale.voided') THEN 'voided'
                 WHEN bool_or(e.type = 'sale.completed') THEN 'completed'
                 WHEN (array_agg(e.type ORDER BY e.device_seq DESC)
                         FILTER (WHERE e.type IN ('sale.suspended', 'sale.resumed')))[1] = 'sale.suspended' THEN 'suspended'
                 ELSE 'open' END AS status,
            max(e.payload->>'price_mode') FILTER (WHERE e.type = 'sale.completed') AS price_mode,
            coalesce(max((e.payload->>'total_cents')::bigint) FILTER (WHERE e.type = 'sale.completed'), 0)::bigint AS total_cents,
            count(*) FILTER (WHERE e.type = 'sale.line_added') AS item_count
       FROM latest
       JOIN sale_events e ON e.sale_id = latest.sale_id
       JOIN registers r ON r.register_id = e.register_id
       JOIN locations l ON l.location_id = e.location_id
      GROUP BY e.sale_id, e.register_id, r.name, l.name
      ORDER BY min(e.occurred_at) DESC`,
    [merchantId, limit],
  );
  return rows.map((r) => ({
    ...r,
    occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  }));
}
