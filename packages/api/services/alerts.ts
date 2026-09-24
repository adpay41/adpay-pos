/**
 * Alert rules (build plan P4 / F3, Bible 2.6 and 3.2). `evaluateAlerts` runs every minute (BullMQ
 * job) and is also callable directly, which is how the tests drive it.
 *
 * Each rule answers "which things are in trouble right now?". An alert opens the first time a thing
 * shows up (one open alert per dedupe key), stays open with `last_seen_at` bumped while the
 * condition holds, and resolves itself when it stops. Opening one notifies the realtime channel and
 * the merchant's notifier (push/SMS/WhatsApp adapters are stubs until those accounts exist).
 */
import { ALERT_RULES, REGISTER_OFFLINE_ALERT_MS, type Alert, type AlertRule, type AlertSeverity } from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { notFound } from '../http/errors';
import { audit } from './audit';

interface Finding {
  rule: AlertRule;
  dedupe_key: string;
  title: string;
  details: Record<string, unknown>;
  org_id: string | null;
  merchant_id: string | null;
  location_id: string | null;
  register_id: string | null;
}

/** Where alerts go beyond the consoles. Real adapters (push, SMS, WhatsApp) need accounts (build plan ⛔). */
export interface Notifier {
  alertOpened(alert: Alert): Promise<void>;
}

export const logNotifier = (log: (obj: object, msg: string) => void): Notifier => ({
  async alertOpened(alert) {
    if (ALERT_RULES[alert.rule].merchant) log({ alert_id: alert.alert_id, rule: alert.rule, merchant_id: alert.merchant_id }, 'alert notification (log adapter: no push/SMS account yet)');
  },
});

/** Queued events older than this, on a register that is otherwise online, count as stuck. */
const QUEUE_STUCK_MS = 10 * 60_000;
const VOID_RATE_MIN_TICKETS = 20;
const VOID_RATE_PERCENT = 10;

async function findings(q: Queryable, now: Date): Promise<Finding[]> {
  const out: Finding[] = [];
  const reg = `r.org_id, r.merchant_id, r.location_id, r.register_id, r.name AS register_name`;

  // Register offline > 5 min (only registers that have ever reported in).
  const offline = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string; register_name: string; last_heartbeat_at: Date }>(
    `SELECT ${reg}, s.last_heartbeat_at FROM registers r JOIN register_status s ON s.register_id = r.register_id
      WHERE r.status = 'active' AND s.last_heartbeat_at < $1::timestamptz - make_interval(secs => $2::int / 1000)`,
    [now.toISOString(), REGISTER_OFFLINE_ALERT_MS],
  );
  for (const r of offline.rows) {
    out.push({
      rule: 'register_offline',
      dedupe_key: `register_offline:${r.register_id}`,
      title: `${r.register_name} is offline`,
      details: { last_heartbeat_at: new Date(r.last_heartbeat_at).toISOString() },
      ...r,
    });
  }

  // Heartbeat says events are queued and the last successful sync is old, while the register is up.
  const stuck = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string; register_name: string; queued: number; last_sync_at: string | null; last_error: string | null }>(
    `SELECT ${reg}, (s.heartbeat->'sync'->>'queued')::int AS queued, s.heartbeat->'sync'->>'last_sync_at' AS last_sync_at,
            s.heartbeat->'sync'->>'last_error' AS last_error
       FROM registers r JOIN register_status s ON s.register_id = r.register_id
      WHERE r.status = 'active' AND (s.heartbeat->'sync'->>'queued')::int > 0
        AND s.last_heartbeat_at > $1::timestamptz - make_interval(secs => $2::int / 1000)
        AND coalesce((s.heartbeat->'sync'->>'last_sync_at')::timestamptz, '-infinity') < $1::timestamptz - make_interval(secs => $3::int / 1000)`,
    [now.toISOString(), REGISTER_OFFLINE_ALERT_MS, QUEUE_STUCK_MS],
  );
  for (const r of stuck.rows) {
    out.push({
      rule: 'queue_stuck',
      dedupe_key: `queue_stuck:${r.register_id}`,
      title: `${r.register_name}: ${r.queued} events waiting to sync`,
      details: { queued: r.queued, last_sync_at: r.last_sync_at, last_error: r.last_error },
      ...r,
    });
  }

  // The server rejected events from this register (the register keeps selling; someone must look).
  const rejected = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string; register_name: string; rejected: number }>(
    `SELECT ${reg}, (s.heartbeat->'sync'->>'rejected')::int AS rejected FROM registers r JOIN register_status s ON s.register_id = r.register_id
      WHERE r.status = 'active' AND (s.heartbeat->'sync'->>'rejected')::int > 0`,
  );
  for (const r of rejected.rows) {
    out.push({ rule: 'events_rejected', dedupe_key: `events_rejected:${r.register_id}`, title: `${r.register_name}: ${r.rejected} events rejected`, details: { rejected: r.rejected }, ...r });
  }

  // Hardware in error (or offline) per slot. Browser "preview" and "not_present" are not problems.
  const hw = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string; register_name: string; slot: string; state: string; detail: string | null }>(
    `SELECT ${reg}, h.key AS slot, h.value->>'state' AS state, h.value->>'detail' AS detail
       FROM registers r JOIN register_status s ON s.register_id = r.register_id, jsonb_each(s.heartbeat->'hardware') h
      WHERE r.status = 'active' AND h.value->>'state' IN ('error', 'offline')
        AND s.last_heartbeat_at > $1::timestamptz - make_interval(secs => $2::int / 1000)`,
    [now.toISOString(), REGISTER_OFFLINE_ALERT_MS],
  );
  for (const r of hw.rows) {
    const { slot, state, detail, ...t } = r;
    out.push({
      rule: 'hardware_error',
      dedupe_key: `hardware_error:${r.register_id}:${slot}`,
      title: `${r.register_name}: ${slot.replace('_', ' ')} ${state}${detail ? ` (${detail})` : ''}`,
      details: { slot, state, detail },
      ...t,
    });
  }

  // Someone got locked out after repeated wrong PINs in the last 30 minutes.
  const locked = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string; register_name: string; user_id: string; name: string | null }>(
    `SELECT DISTINCT ON (e.register_id, e.payload->>'user_id') ${reg}, e.payload->>'user_id' AS user_id, u.name
       FROM sale_events e JOIN registers r ON r.register_id = e.register_id LEFT JOIN users u ON u.user_id::text = e.payload->>'user_id'
      WHERE e.type = 'staff.pin_failed' AND (e.payload->>'locked')::boolean
        AND e.received_at > $1::timestamptz - interval '30 minutes'`,
    [now.toISOString()],
  );
  for (const r of locked.rows) {
    const { user_id, name, ...t } = r;
    out.push({
      rule: 'pin_lockout',
      dedupe_key: `pin_lockout:${r.register_id}:${user_id}`,
      title: `${name ?? 'Someone'} was locked out at ${r.register_name} after wrong PINs`,
      details: { user_id, name },
      ...t,
    });
  }

  // Voids today above 10% of tickets (at least 20 tickets), per location, local business date.
  const voids = await q.query<{ org_id: string; merchant_id: string; location_id: string; location_name: string; tickets: number; voids: number; business_date: string }>(
    `SELECT e.org_id, e.merchant_id, e.location_id, l.name AS location_name, to_char(e.business_date, 'YYYY-MM-DD') AS business_date,
            count(*) FILTER (WHERE e.type = 'sale.opened')::int AS tickets, count(*) FILTER (WHERE e.type = 'sale.voided')::int AS voids
       FROM sale_events e JOIN locations l ON l.location_id = e.location_id
      WHERE e.business_date = ($1::timestamptz AT TIME ZONE l.timezone)::date AND e.type IN ('sale.opened', 'sale.voided')
      GROUP BY 1, 2, 3, 4, 5`,
    [now.toISOString()],
  );
  for (const r of voids.rows) {
    if (r.tickets < VOID_RATE_MIN_TICKETS || r.voids * 100 < r.tickets * VOID_RATE_PERCENT) continue;
    out.push({
      rule: 'high_void_rate',
      dedupe_key: `high_void_rate:${r.location_id}:${r.business_date}`,
      title: `${r.location_name}: ${r.voids} voids out of ${r.tickets} tickets today`,
      details: { voids: r.voids, tickets: r.tickets, business_date: r.business_date },
      org_id: r.org_id,
      merchant_id: r.merchant_id,
      location_id: r.location_id,
      register_id: null,
    });
  }
  return out;
}

export interface EvaluateResult {
  opened: Alert[];
  resolved: number;
  still_open: number;
}

/** Reconcile open alerts with what the rules find now. Safe to run concurrently (unique open key). */
export async function evaluateAlerts(db: Db, notifier: Notifier | null, now = new Date(), traceId = 'alert-rules'): Promise<EvaluateResult> {
  const found = await findings(db, now);
  const keys = found.map((f) => f.dedupe_key);
  const openedIds: string[] = [];
  let resolved = 0;
  await db.tx(async (q) => {
    for (const f of found) {
      const severity: AlertSeverity = ALERT_RULES[f.rule].severity;
      const { rows } = await q.query<{ alert_id: string; inserted: boolean }>(
        `INSERT INTO alerts (rule, severity, dedupe_key, title, details, org_id, merchant_id, location_id, register_id, opened_at, last_seen_at, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
         ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
         DO UPDATE SET last_seen_at = $10, title = EXCLUDED.title, details = EXCLUDED.details
         RETURNING alert_id, (xmax = 0) AS inserted`,
        [f.rule, severity, f.dedupe_key, f.title, JSON.stringify(f.details), f.org_id, f.merchant_id, f.location_id, f.register_id, now.toISOString(), traceId],
      );
      if (rows[0]!.inserted) openedIds.push(rows[0]!.alert_id);
    }
    const r = await q.query<{ alert_id: string }>(
      `UPDATE alerts SET resolved_at = $2 WHERE resolved_at IS NULL AND NOT (dedupe_key = ANY($1::text[])) RETURNING alert_id`,
      [keys, now.toISOString()],
    );
    resolved = r.rows.length;
    for (const id of openedIds) await q.query('SELECT pg_notify($1, $2)', ['adpay_alert', JSON.stringify({ alert_id: id })]);
  });
  const opened = openedIds.length ? await listAlerts(db, { ids: openedIds, openOnly: false, limit: openedIds.length }) : [];
  for (const a of opened) await notifier?.alertOpened(a).catch(() => undefined);
  return { opened, resolved, still_open: found.length - opened.length };
}

interface AlertRow extends Omit<Alert, 'opened_at' | 'last_seen_at' | 'resolved_at' | 'acknowledged_at'> {
  opened_at: Date | string;
  last_seen_at: Date | string;
  resolved_at: Date | string | null;
  acknowledged_at: Date | string | null;
}
const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

export async function listAlerts(
  q: Queryable,
  f: { merchantId?: string | null; registerId?: string; ids?: string[]; openOnly: boolean; merchantFacing?: boolean; limit: number },
): Promise<Alert[]> {
  const merchantRules = (Object.keys(ALERT_RULES) as AlertRule[]).filter((r) => ALERT_RULES[r].merchant);
  const { rows } = await q.query<AlertRow>(
    `SELECT a.alert_id, a.rule, a.severity, a.title, a.details, a.merchant_id, m.name AS merchant_name, l.name AS location_name,
            a.register_id, r.name AS register_name, a.opened_at, a.last_seen_at, a.resolved_at, a.acknowledged_at,
            coalesce(u.name, u.email) AS acknowledged_by_name
       FROM alerts a
       LEFT JOIN merchants m ON m.merchant_id = a.merchant_id
       LEFT JOIN locations l ON l.location_id = a.location_id
       LEFT JOIN registers r ON r.register_id = a.register_id
       LEFT JOIN users u ON u.user_id = a.acknowledged_by
      WHERE ($1::uuid IS NULL OR a.merchant_id = $1) AND ($2::uuid IS NULL OR a.register_id = $2)
        AND ($3::uuid[] IS NULL OR a.alert_id = ANY($3)) AND (NOT $4 OR a.resolved_at IS NULL)
        AND (NOT $5 OR a.rule = ANY($6::text[]))
      ORDER BY a.resolved_at IS NOT NULL, CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.opened_at DESC
      LIMIT $7`,
    [f.merchantId ?? null, f.registerId ?? null, f.ids ?? null, f.openOnly, !!f.merchantFacing, merchantRules, f.limit],
  );
  return rows.map((r) => ({
    ...r,
    opened_at: iso(r.opened_at)!,
    last_seen_at: iso(r.last_seen_at)!,
    resolved_at: iso(r.resolved_at),
    acknowledged_at: iso(r.acknowledged_at),
  }));
}

export async function acknowledgeAlert(db: Db, actor: AdminPrincipal | MerchantUserPrincipal, alertId: string, traceId: string): Promise<void> {
  const { rows } = await db.query<{ org_id: string | null; merchant_id: string | null }>(
    `UPDATE alerts SET acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2)
      WHERE alert_id = $1 AND ($3::uuid IS NULL OR merchant_id = $3) RETURNING org_id, merchant_id`,
    [alertId, actor.user_id, actor.kind === 'merchant_user' ? actor.merchant_id : null],
  );
  if (!rows[0]) throw notFound('Alert not found');
  await audit(db, { actor, action: 'alert.acknowledged', tenancy: { org_id: rows[0].org_id, merchant_id: rows[0].merchant_id }, target: alertId, trace_id: traceId });
}
