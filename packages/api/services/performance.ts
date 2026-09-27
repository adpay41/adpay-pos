/**
 * Cashier performance and the accountant's daily journal (P19b, ADR 0030).
 *
 * Cashier performance (Bible 2.5): per person over a date range, everything folded from the events:
 * sales and gross, dollars per hour on the clock, voids, refunds, "no sale" drawer opens, drawer
 * over/short on the counts they closed, and age checks (done, by ID scan, and age-restricted lines
 * sold without one).
 *
 * The daily journal (Bible 2.2, accountant access): one row per store-local day, in the columns a
 * bookkeeper posts to QuickBooks or Xero by CSV import. A direct QuickBooks/Xero sync needs their
 * OAuth apps (build plan, deferred); this is the file that sync would send.
 */
import { overShortByCashier, sum, type DrawerSession, type JournalDay } from '@adpay/shared';
import type { Queryable } from '../db/db';
import { drawerSessions } from './cash';
import { timesheet } from './timeclock';

export interface CashierPerformanceRow {
  user_id: string;
  name: string;
  sales: number;
  gross_cents: number;
  avg_ticket_cents: number | null;
  minutes_on_clock: number;
  /** Gross per hour on the clock; null without clocked time. */
  per_hour_cents: number | null;
  voids: number;
  refunds: number;
  refund_cents: number;
  no_sale_opens: number;
  drawer_counts: number;
  over_short_cents: number | null;
  age_checks: number;
  id_scans: number;
  /** Age-restricted lines sold on their completed sales without a recorded check. */
  age_checks_missed: number;
}

export async function cashierPerformance(q: Queryable, merchantId: string, from: string, to: string): Promise<{ from: string; to: string; cashiers: CashierPerformanceRow[] }> {
  const range = [merchantId, from, to];
  const inRange = `e.merchant_id = $1 AND e.business_date BETWEEN $2::date AND $3::date`;
  const { rows: sales } = await q.query<{ user_id: string; n: number; gross: number }>(
    `SELECT e.actor_user_id AS user_id, count(*)::int AS n, sum((e.payload->>'total_cents')::bigint)::bigint AS gross
       FROM sale_events e
      WHERE ${inRange} AND e.type = 'sale.completed' AND e.actor_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sale_events v WHERE v.sale_id = e.sale_id AND v.type = 'sale.voided')
      GROUP BY 1`,
    range,
  );
  const { rows: acts } = await q.query<{ user_id: string; voids: number; refunds: number; refund_cents: number; no_sale: number; checks: number; scans: number }>(
    `SELECT coalesce(e.payload->>'by_user_id', e.payload->>'verified_by_user_id', e.actor_user_id::text) AS user_id,
            count(*) FILTER (WHERE e.type = 'sale.voided')::int AS voids,
            count(*) FILTER (WHERE e.type = 'sale.refunded' AND e.payload->>'reason' NOT LIKE 'Void%')::int AS refunds,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.refunded' AND e.payload->>'reason' NOT LIKE 'Void%'), 0)::bigint AS refund_cents,
            count(*) FILTER (WHERE e.type = 'drawer.opened' AND e.payload->>'reason' = 'manual')::int AS no_sale,
            count(*) FILTER (WHERE e.type = 'sale.age_verified')::int AS checks,
            count(*) FILTER (WHERE e.type = 'sale.age_verified' AND e.payload->>'method' = 'id_scan')::int AS scans
       FROM sale_events e
      WHERE ${inRange} AND e.type IN ('sale.voided', 'sale.refunded', 'drawer.opened', 'sale.age_verified')
      GROUP BY 1`,
    range,
  );
  const { rows: missed } = await q.query<{ user_id: string; n: number }>(
    `SELECT c.actor_user_id AS user_id, count(*)::int AS n
       FROM sale_events l
       JOIN sale_events c ON c.sale_id = l.sale_id AND c.type = 'sale.completed'
      WHERE l.merchant_id = $1 AND l.business_date BETWEEN $2::date AND $3::date AND l.type = 'sale.line_added'
        AND (l.payload->>'min_age') IS NOT NULL AND c.actor_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sale_events x WHERE x.sale_id = l.sale_id AND x.type IN ('sale.age_verified', 'sale.line_removed')
                          AND x.payload->>'line_id' = l.payload->>'line_id')
      GROUP BY 1`,
    range,
  );
  const sessions = (await drawerSessions(q, merchantId, from, null)).filter((s) => s.business_date <= to) as DrawerSession[];
  const drawers = overShortByCashier(sessions);
  const clock = await timesheet(q, merchantId, from, to);

  const ids = new Set<string>([...sales.map((r) => r.user_id), ...acts.map((r) => r.user_id), ...missed.map((r) => r.user_id), ...clock.rows.map((r) => r.user_id)]);
  for (const d of drawers) if (d.user_id) ids.add(d.user_id);
  const { rows: people } = await q.query<{ user_id: string; name: string }>(
    `SELECT u.user_id, u.name FROM users u JOIN memberships m ON m.user_id = u.user_id AND m.merchant_id = $1 WHERE u.user_id = ANY($2::uuid[])`,
    [merchantId, [...ids].filter((x) => /^[0-9a-f-]{36}$/i.test(x))],
  );
  const cashiers = people.map((p): CashierPerformanceRow => {
    const s = sales.find((r) => r.user_id === p.user_id);
    const a = acts.find((r) => r.user_id === p.user_id);
    const d = drawers.find((r) => r.user_id === p.user_id);
    const minutes = clock.rows.find((r) => r.user_id === p.user_id)?.total_minutes ?? 0;
    const gross = Number(s?.gross ?? 0);
    const n = s?.n ?? 0;
    return {
      user_id: p.user_id,
      name: p.name,
      sales: n,
      gross_cents: gross,
      avg_ticket_cents: n ? Math.round(gross / n) : null,
      minutes_on_clock: minutes,
      per_hour_cents: minutes ? Math.round((gross * 60) / minutes) : null,
      voids: a?.voids ?? 0,
      refunds: a?.refunds ?? 0,
      refund_cents: Number(a?.refund_cents ?? 0),
      no_sale_opens: a?.no_sale ?? 0,
      drawer_counts: d?.sessions ?? 0,
      over_short_cents: d ? d.over_short_cents : null,
      age_checks: a?.checks ?? 0,
      id_scans: a?.scans ?? 0,
      age_checks_missed: missed.find((r) => r.user_id === p.user_id)?.n ?? 0,
    };
  });
  cashiers.sort((x, y) => y.gross_cents - x.gross_cents || x.name.localeCompare(y.name));
  return { from, to, cashiers };
}

/** One row per store and day: what the books need, from the events. */
export async function dailyJournal(q: Queryable, merchantId: string, from: string, to: string): Promise<JournalDay[]> {
  const { rows } = await q.query<{
    date: string; location_id: string; location: string; net: number; tax: number; gross: number; refunds: number; cash: number; card: number; checks: number; others: number;
    paid_out: number; paid_in: number; drops: number;
  }>(
    `WITH ok AS (
       SELECT c.sale_id FROM sale_events c
        WHERE c.merchant_id = $1 AND c.type = 'sale.completed' AND c.business_date BETWEEN $2::date AND $3::date
          AND NOT EXISTS (SELECT 1 FROM sale_events v WHERE v.sale_id = c.sale_id AND v.type = 'sale.voided'))
     SELECT to_char(e.business_date, 'YYYY-MM-DD') AS date, l.location_id, l.name AS location,
            coalesce(sum((e.payload->>'subtotal_cents')::bigint) FILTER (WHERE e.type = 'sale.completed' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS net,
            coalesce(sum((e.payload->>'tax_cents')::bigint) FILTER (WHERE e.type = 'sale.completed' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS tax,
            coalesce(sum((e.payload->>'total_cents')::bigint) FILTER (WHERE e.type = 'sale.completed' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS gross,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.refunded' AND e.payload->>'reason' NOT LIKE 'Void%'), 0)::bigint AS refunds,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'cash' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS cash,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'card' AND e.sale_id IN (SELECT sale_id FROM ok) AND e.payload->'card'->>'status' = 'approved'), 0)::bigint AS card,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'check' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS checks,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'sale.tender_added' AND e.payload->>'tender_type' = 'other' AND e.sale_id IN (SELECT sale_id FROM ok)), 0)::bigint AS others,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'drawer.cash_movement' AND e.payload->>'kind' = 'paid_out'), 0)::bigint AS paid_out,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'drawer.cash_movement' AND e.payload->>'kind' = 'paid_in'), 0)::bigint AS paid_in,
            coalesce(sum((e.payload->>'amount_cents')::bigint) FILTER (WHERE e.type = 'drawer.cash_movement' AND e.payload->>'kind' = 'drop'), 0)::bigint AS drops
       FROM sale_events e JOIN locations l ON l.location_id = e.location_id
      WHERE e.merchant_id = $1 AND e.business_date BETWEEN $2::date AND $3::date
        AND e.type IN ('sale.completed', 'sale.refunded', 'sale.tender_added', 'drawer.cash_movement')
      GROUP BY 1, 2, 3
      ORDER BY 1, 3`,
    [merchantId, from, to],
  );
  const sessions = (await drawerSessions(q, merchantId, from, null)).filter((s) => s.business_date <= to);
  return rows.map((r) => ({
    date: r.date,
    location: r.location,
    net_sales_cents: Number(r.net),
    tax_cents: Number(r.tax),
    gross_cents: Number(r.gross),
    refunds_cents: Number(r.refunds),
    cash_cents: Number(r.cash),
    card_cents: Number(r.card),
    check_cents: Number(r.checks),
    other_cents: Number(r.others),
    paid_out_cents: Number(r.paid_out),
    paid_in_cents: Number(r.paid_in),
    drops_cents: Number(r.drops),
    over_short_cents: sum(sessions.filter((s) => s.business_date === r.date && s.location_id === r.location_id && s.over_short_cents !== null).map((s) => s.over_short_cents!)),
  }));
}

