/**
 * Z-reports on the server (build plan P16, ADR 0025). Each `eod.closed` event names the range of
 * the register's events it covered; the server rebuilds the Z from exactly those events with the
 * shared `buildZReport` and compares with what the register printed. A difference is flagged,
 * never corrected: both stay on record.
 */
import { RegisterEventSchema, buildZReport, zTotals, type RegisterEvent, type ZReport, type ZTotals } from '@adpay/shared';
import type { Queryable } from '../db/db';

export interface ZRow {
  event_id: string;
  register_id: string;
  register_name: string;
  location_name: string;
  closed_at: string;
  closed_by_name: string | null;
  declared: ZTotals;
  z: ZReport;
  /** The register's printed totals differ from the rebuild (events missing or changed in transit). */
  mismatch: boolean;
}

type Row = Record<string, unknown> & { occurred_at: Date | string };
const toEvent = (r: Row): RegisterEvent => RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() });
const ENVELOPE = `e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id,
                  e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload`;

export async function zReports(q: Queryable, merchantId: string, from: string, to: string): Promise<ZRow[]> {
  const { rows } = await q.query<Row & { register_name: string; location_name: string; closed_by_name: string | null }>(
    `SELECT ${ENVELOPE}, r.name AS register_name, l.name AS location_name, u.name AS closed_by_name
       FROM sale_events e JOIN registers r ON r.register_id = e.register_id JOIN locations l ON l.location_id = e.location_id
       LEFT JOIN users u ON u.user_id = e.actor_user_id
      WHERE e.merchant_id = $1 AND e.type = 'eod.closed' AND (e.payload->>'business_date')::date BETWEEN $2::date AND $3::date
      ORDER BY e.occurred_at DESC LIMIT 200`,
    [merchantId, from, to],
  );
  const { rows: cats } = await q.query<{ category_id: string; name: string }>('SELECT category_id, name FROM categories WHERE merchant_id = $1', [merchantId]);
  const names = new Map(cats.map((c) => [c.category_id, c.name]));
  const out: ZRow[] = [];
  for (const r of rows) {
    const { register_name: _r, location_name: _l, closed_by_name: _c, ...envelope } = r;
    const e = toEvent(envelope as Row);
    if (e.type !== 'eod.closed') continue;
    const { rows: covered } = await q.query<Row>(
      `SELECT ${ENVELOPE} FROM sale_events e WHERE e.register_id = $1 AND e.device_seq BETWEEN $2 AND $3 ORDER BY e.device_seq`,
      [e.register_id, e.payload.from_seq, e.payload.to_seq],
    );
    const z = buildZReport(covered.map(toEvent), {
      z_number: e.payload.z_number,
      register_id: e.register_id,
      business_date: e.payload.business_date,
      from_seq: e.payload.from_seq,
      categoryName: (id) => (id ? (names.get(id) ?? 'Other') : 'No category'),
    });
    const rebuilt = zTotals(z);
    const declared = e.payload.totals;
    out.push({
      event_id: e.event_id,
      register_id: e.register_id,
      register_name: r.register_name,
      location_name: r.location_name,
      closed_at: e.occurred_at,
      closed_by_name: r.closed_by_name,
      declared,
      z,
      mismatch: (Object.keys(rebuilt) as (keyof ZTotals)[]).some((k) => rebuilt[k] !== declared[k]),
    });
  }
  return out;
}
