/**
 * Multi-store roll-up (Bible 2.1, P19b, ADR 0030): for an owner with 2–5 stores, every store they can
 * see reports for, side by side, with the totals and the same-length period before. A store is in the
 * roll-up only where this person's role there includes `reports.view`; each store's days are its own
 * local days.
 */
import { permissionsFor, PermissionOverridesSchema, type Role } from '@adpay/shared';
import type { Queryable } from '../db/db';

export interface RollupRow {
  merchant_id: string;
  merchant_name: string;
  location_id: string;
  location_name: string;
  tickets: number;
  gross_cents: number;
  avg_ticket_cents: number | null;
  card_tickets: number;
  prev_tickets: number;
  prev_gross_cents: number;
}

export interface Rollup {
  range: 'today' | 'week' | 'month';
  stores: RollupRow[];
  total: { tickets: number; gross_cents: number; prev_tickets: number; prev_gross_cents: number };
}

export async function rollup(q: Queryable, userId: string, range: Rollup['range']): Promise<Rollup> {
  const { rows: ms } = await q.query<{ merchant_id: string; role: Role; permission_overrides: unknown }>(
    `SELECT m.merchant_id, m.role, mc.permission_overrides
       FROM memberships m JOIN merchants mc ON mc.merchant_id = m.merchant_id
      WHERE m.user_id = $1 AND m.disabled_at IS NULL`,
    [userId],
  );
  const merchants = ms
    .filter((m) => {
      const o = PermissionOverridesSchema.safeParse(m.permission_overrides ?? {});
      return permissionsFor(m.role, o.success ? o.data : {}).includes('reports.view');
    })
    .map((m) => m.merchant_id);
  if (merchants.length === 0) return { range, stores: [], total: { tickets: 0, gross_cents: 0, prev_tickets: 0, prev_gross_cents: 0 } };

  const { rows } = await q.query<{
    merchant_id: string; merchant_name: string; location_id: string; location_name: string;
    tickets: number; gross: number; card_tickets: number; prev_tickets: number; prev_gross: number;
  }>(
    `WITH loc AS (
       SELECT l.merchant_id, m.name AS merchant_name, l.location_id, l.name AS location_name,
              (now() AT TIME ZONE l.timezone)::date AS today
         FROM locations l JOIN merchants m ON m.merchant_id = l.merchant_id
        WHERE l.merchant_id = ANY($1::uuid[])),
     win AS (
       SELECT loc.*, CASE $2::text WHEN 'today' THEN today WHEN 'week' THEN today - 6 ELSE date_trunc('month', today)::date END AS d_from
         FROM loc),
     sales AS (
       SELECT c.location_id, c.business_date, (c.payload->>'total_cents')::bigint AS total, c.payload->>'price_mode' AS mode
         FROM sale_events c
        WHERE c.merchant_id = ANY($1::uuid[]) AND c.type = 'sale.completed' AND c.business_date >= (SELECT min(d_from) FROM win) - 62
          AND NOT EXISTS (SELECT 1 FROM sale_events v WHERE v.sale_id = c.sale_id AND v.type = 'sale.voided'))
     SELECT w.merchant_id, w.merchant_name, w.location_id, w.location_name,
            count(s.*) FILTER (WHERE s.business_date BETWEEN w.d_from AND w.today)::int AS tickets,
            coalesce(sum(s.total) FILTER (WHERE s.business_date BETWEEN w.d_from AND w.today), 0)::bigint AS gross,
            count(s.*) FILTER (WHERE s.business_date BETWEEN w.d_from AND w.today AND s.mode = 'card')::int AS card_tickets,
            count(s.*) FILTER (WHERE s.business_date BETWEEN w.d_from - (w.today - w.d_from + 1) AND w.d_from - 1)::int AS prev_tickets,
            coalesce(sum(s.total) FILTER (WHERE s.business_date BETWEEN w.d_from - (w.today - w.d_from + 1) AND w.d_from - 1), 0)::bigint AS prev_gross
       FROM win w LEFT JOIN sales s ON s.location_id = w.location_id
      GROUP BY w.merchant_id, w.merchant_name, w.location_id, w.location_name
      ORDER BY gross DESC, w.merchant_name, w.location_name`,
    [merchants, range],
  );
  const stores = rows.map((r) => ({
    merchant_id: r.merchant_id,
    merchant_name: r.merchant_name,
    location_id: r.location_id,
    location_name: r.location_name,
    tickets: r.tickets,
    gross_cents: Number(r.gross),
    avg_ticket_cents: r.tickets ? Math.round(Number(r.gross) / r.tickets) : null,
    card_tickets: r.card_tickets,
    prev_tickets: r.prev_tickets,
    prev_gross_cents: Number(r.prev_gross),
  }));
  return {
    range,
    stores,
    total: {
      tickets: stores.reduce((n, s) => n + s.tickets, 0),
      gross_cents: stores.reduce((n, s) => n + s.gross_cents, 0),
      prev_tickets: stores.reduce((n, s) => n + s.prev_tickets, 0),
      prev_gross_cents: stores.reduce((n, s) => n + s.prev_gross_cents, 0),
    },
  };
}
