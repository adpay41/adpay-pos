/**
 * The ops layer (build plan P4 / F3, spec step 3): heartbeat ingest, device log uploads, the remote
 * action queue, and the reads behind the admin fleet list and device page.
 *
 * Everything is scoped by the caller's credential: a device writes only its own rows, and a merchant
 * user reads only their merchant's registers. Admin reads are cross-tenant by role.
 */
import {
  REMOTE_ACTIONS,
  type DevicePage,
  type DeviceLogLine,
  type FleetRow,
  type Heartbeat,
  type HeartbeatResponse,
  type RemoteAction,
  type RemoteActionKind,
  type RemoteActionStatus,
} from '@adpay/shared';
import type { AdminPrincipal, DevicePrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { listAlerts } from './alerts';
import { audit } from './audit';

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

// ─────────────────────────────────────────────────────────── heartbeat ──

/**
 * Record a heartbeat and answer with the actions waiting for this register. Actions handed out
 * here are marked delivered; the WebSocket is only a faster path to the same queue.
 */
export async function recordHeartbeat(db: Db, d: DevicePrincipal, hb: Heartbeat, traceId: string): Promise<HeartbeatResponse> {
  return db.tx(async (q) => {
    await q.query(
      `INSERT INTO register_status (register_id, org_id, merchant_id, location_id, last_heartbeat_at, app_version, platform, heartbeat, ws_connected, trace_id)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
       ON CONFLICT (register_id) DO UPDATE SET last_heartbeat_at = now(), app_version = $5, platform = $6, heartbeat = $7,
              ws_connected = $8, trace_id = $9`,
      [d.register_id, d.org_id, d.merchant_id, d.location_id, hb.app_version, hb.platform, JSON.stringify(hb), hb.ws_connected, traceId],
    );
    await q.query(
      `INSERT INTO register_heartbeats (register_id, org_id, merchant_id, location_id, heartbeat, trace_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.register_id, d.org_id, d.merchant_id, d.location_id, JSON.stringify(hb), traceId],
    );
    await q.query(`UPDATE registers SET last_seen_at = now() WHERE register_id = $1`, [d.register_id]);
    await q.query('SELECT pg_notify($1, $2)', [
      'adpay_register',
      JSON.stringify({ register_id: d.register_id, merchant_id: d.merchant_id, last_heartbeat_at: new Date().toISOString() }),
    ]);
    const actions = await takePendingActions(q, d.register_id);
    const { rows } = await q.query<{ catalog_version: number }>('SELECT catalog_version FROM merchants WHERE merchant_id = $1', [d.merchant_id]);
    return { server_time: new Date().toISOString(), catalog_version: rows[0]!.catalog_version, actions };
  });
}

export async function setWsConnected(q: Queryable, registerId: string, connected: boolean): Promise<void> {
  await q.query('UPDATE register_status SET ws_connected = $2 WHERE register_id = $1', [registerId, connected]);
}

// ─────────────────────────────────────────────────────────── logs ──

export async function storeLogUpload(db: Db, d: DevicePrincipal, actionId: string | null, lines: DeviceLogLine[], traceId: string): Promise<{ upload_id: string; line_count: number }> {
  const { rows } = await db.query<{ upload_id: string }>(
    `INSERT INTO device_log_uploads (register_id, org_id, merchant_id, location_id, action_id, line_count, lines, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING upload_id`,
    [d.register_id, d.org_id, d.merchant_id, d.location_id, actionId, lines.length, JSON.stringify(lines), traceId],
  );
  return { upload_id: rows[0]!.upload_id, line_count: lines.length };
}

// ─────────────────────────────────────────────────────────── remote actions ──

interface ActionRow {
  action_id: string;
  register_id: string;
  kind: RemoteActionKind;
  params: { sale_id?: string };
  status: RemoteActionStatus;
  requested_at: Date | string;
  requested_by_name: string | null;
  delivered_at: Date | string | null;
  completed_at: Date | string | null;
  result: { message: string } | null;
}

const toAction = (r: ActionRow): RemoteAction => ({
  ...r,
  requested_at: iso(r.requested_at)!,
  delivered_at: iso(r.delivered_at),
  completed_at: iso(r.completed_at),
});

const ACTION_SELECT = `SELECT a.action_id, a.register_id, a.kind, a.params, a.status, a.requested_at, a.delivered_at, a.completed_at, a.result,
                              coalesce(u.name, u.email) AS requested_by_name
                         FROM remote_actions a LEFT JOIN users u ON u.user_id = a.requested_by`;

/** Queued actions for a register, marked delivered in the same statement (so each is handed out once per poll). */
export async function takePendingActions(q: Queryable, registerId: string): Promise<RemoteAction[]> {
  await q.query(`UPDATE remote_actions SET status = 'expired' WHERE register_id = $1 AND status IN ('queued', 'delivered') AND expires_at < now()`, [registerId]);
  const { rows } = await q.query<{ action_id: string }>(
    `UPDATE remote_actions SET status = 'delivered', delivered_at = coalesce(delivered_at, now())
      WHERE register_id = $1 AND status = 'queued' RETURNING action_id`,
    [registerId],
  );
  if (rows.length === 0) return [];
  const got = await q.query<ActionRow>(`${ACTION_SELECT} WHERE a.action_id = ANY($1::uuid[]) ORDER BY a.requested_at`, [rows.map((r) => r.action_id)]);
  return got.rows.map(toAction);
}

/** One action for the realtime push; marks it delivered if it was still queued. */
export async function deliverAction(q: Queryable, actionId: string): Promise<RemoteAction | null> {
  const { rows } = await q.query<{ action_id: string }>(
    `UPDATE remote_actions SET status = 'delivered', delivered_at = now()
      WHERE action_id = $1 AND status = 'queued' AND expires_at > now() RETURNING action_id`,
    [actionId],
  );
  if (!rows[0]) return null;
  const got = await q.query<ActionRow>(`${ACTION_SELECT} WHERE a.action_id = $1`, [actionId]);
  return got.rows[0] ? toAction(got.rows[0]) : null;
}

export async function requestAction(
  db: Db,
  actor: AdminPrincipal | MerchantUserPrincipal,
  registerId: string,
  kind: RemoteActionKind,
  params: { sale_id?: string | undefined },
  traceId: string,
): Promise<RemoteAction> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; merchant_id: string; location_id: string; status: string }>(
      'SELECT org_id, merchant_id, location_id, status FROM registers WHERE register_id = $1',
      [registerId],
    );
    const reg = rows[0];
    // A merchant user may only act on their own registers; anything else is a 404.
    if (!reg || (actor.kind === 'merchant_user' && reg.merchant_id !== actor.merchant_id)) throw notFound('Register not found');
    if (reg.status !== 'active') throw badRequest('That register is not paired yet');
    if (params.sale_id) {
      const s = await q.query('SELECT 1 FROM sale_events WHERE sale_id = $1 AND register_id = $2 LIMIT 1', [params.sale_id, registerId]);
      if (!s.rows[0]) throw badRequest('That sale was not rung on this register');
    }
    const ins = await q.query<{ action_id: string }>(
      `INSERT INTO remote_actions (register_id, org_id, merchant_id, location_id, kind, params, requested_by, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING action_id`,
      [registerId, reg.org_id, reg.merchant_id, reg.location_id, kind, JSON.stringify(params), actor.user_id, traceId],
    );
    const actionId = ins.rows[0]!.action_id;
    await audit(q, {
      actor,
      action: 'register.remote_action',
      tenancy: { org_id: reg.org_id, merchant_id: reg.merchant_id, location_id: reg.location_id, register_id: registerId },
      target: actionId,
      details: { kind, params, label: REMOTE_ACTIONS[kind].label },
      trace_id: traceId,
    });
    const got = await q.query<ActionRow>(`${ACTION_SELECT} WHERE a.action_id = $1`, [actionId]);
    return toAction(got.rows[0]!);
  });
}

/** The register reports how an action went. Only its own actions, only once. */
export async function completeAction(
  db: Db,
  d: DevicePrincipal,
  actionId: string,
  status: 'succeeded' | 'failed' | 'unsupported',
  message: string,
): Promise<RemoteAction> {
  const { rows } = await db.query<{ action_id: string }>(
    `UPDATE remote_actions SET status = $3, completed_at = now(), result = $4, delivered_at = coalesce(delivered_at, now())
      WHERE action_id = $1 AND register_id = $2 AND status IN ('queued', 'delivered') RETURNING action_id`,
    [actionId, d.register_id, status, JSON.stringify({ message })],
  );
  if (!rows[0]) throw notFound('No open action with that id for this register');
  const got = await db.query<ActionRow>(`${ACTION_SELECT} WHERE a.action_id = $1`, [actionId]);
  return toAction(got.rows[0]!);
}

// ─────────────────────────────────────────────────────────── fleet & device page ──

interface FleetSql {
  register_id: string;
  register_name: string;
  status: 'unpaired' | 'active' | 'retired';
  merchant_id: string;
  merchant_name: string;
  location_id: string;
  location_name: string;
  last_heartbeat_at: Date | string | null;
  app_version: string | null;
  platform: string | null;
  heartbeat: Heartbeat | null;
  server_catalog_version: number;
  ws_connected: boolean | null;
  open_alerts: number;
}

const FLEET_SELECT = `
  SELECT r.register_id, r.name AS register_name, r.status, m.merchant_id, m.name AS merchant_name, l.location_id, l.name AS location_name,
         s.last_heartbeat_at, s.app_version, s.platform, s.heartbeat, m.catalog_version AS server_catalog_version, s.ws_connected,
         (SELECT count(*)::int FROM alerts a WHERE a.register_id = r.register_id AND a.resolved_at IS NULL) AS open_alerts
    FROM registers r
    JOIN locations l ON l.location_id = r.location_id
    JOIN merchants m ON m.merchant_id = r.merchant_id
    LEFT JOIN register_status s ON s.register_id = r.register_id`;

const toFleet = (r: FleetSql): FleetRow => ({
  register_id: r.register_id,
  register_name: r.register_name,
  status: r.status,
  merchant_id: r.merchant_id,
  merchant_name: r.merchant_name,
  location_id: r.location_id,
  location_name: r.location_name,
  last_heartbeat_at: iso(r.last_heartbeat_at),
  app_version: r.app_version,
  platform: r.platform,
  queued: r.heartbeat?.sync.queued ?? null,
  last_sync_at: r.heartbeat?.sync.last_sync_at ?? null,
  device_catalog_version: r.heartbeat?.catalog_version ?? null,
  server_catalog_version: r.server_catalog_version,
  ws_connected: !!r.ws_connected,
  open_alerts: r.open_alerts,
  hardware: r.heartbeat?.hardware ?? null,
});

export async function fleet(q: Queryable, merchantId: string | null): Promise<FleetRow[]> {
  const { rows } = await q.query<FleetSql>(
    `${FLEET_SELECT} WHERE r.status <> 'retired' AND ($1::uuid IS NULL OR r.merchant_id = $1)
      ORDER BY m.name, l.name, r.name`,
    [merchantId],
  );
  return rows.map(toFleet);
}

export async function devicePage(q: Queryable, registerId: string, merchantId: string | null): Promise<DevicePage> {
  const { rows } = await q.query<FleetSql>(`${FLEET_SELECT} WHERE r.register_id = $1 AND ($2::uuid IS NULL OR r.merchant_id = $2)`, [
    registerId,
    merchantId,
  ]);
  const row = rows[0];
  if (!row) throw notFound('Register not found');

  const signedIn = row.heartbeat?.signed_in_user_id
    ? (await q.query<{ name: string }>('SELECT name FROM users WHERE user_id = $1', [row.heartbeat.signed_in_user_id])).rows[0]?.name ?? null
    : null;
  const beats = await q.query<{ received_at: Date | string; queued: number; online: boolean }>(
    `SELECT received_at, (heartbeat->'sync'->>'queued')::int AS queued, (heartbeat->'network'->>'online')::boolean AS online
       FROM register_heartbeats WHERE register_id = $1 AND received_at > now() - interval '1 hour' ORDER BY received_at DESC LIMIT 120`,
    [registerId],
  );
  const actions = await q.query<ActionRow>(`${ACTION_SELECT} WHERE a.register_id = $1 ORDER BY a.requested_at DESC LIMIT 30`, [registerId]);
  const logs = await q.query<{ uploaded_at: Date | string; lines: DeviceLogLine[] }>(
    'SELECT uploaded_at, lines FROM device_log_uploads WHERE register_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
    [registerId],
  );
  const events = await q.query<{ event_id: string; type: string; sale_id: string | null; occurred_at: Date | string; received_at: Date | string; actor_name: string | null }>(
    `SELECT e.event_id, e.type, e.sale_id, e.occurred_at, e.received_at, u.name AS actor_name
       FROM sale_events e LEFT JOIN users u ON u.user_id = e.actor_user_id
      WHERE e.register_id = $1 AND e.received_at > now() - interval '31 days'
      ORDER BY e.received_at DESC, e.device_seq DESC LIMIT 50`,
    [registerId],
  );
  const lastLog = logs.rows[0];
  return {
    ...toFleet(row),
    heartbeat: row.heartbeat,
    signed_in_name: signedIn,
    recent_heartbeats: beats.rows.map((b) => ({ received_at: iso(b.received_at)!, queued: b.queued, online: b.online })),
    actions: actions.rows.map(toAction),
    // The device page shows the last 200 lines, newest last (spec: "read the last 200 log lines").
    logs: lastLog ? { uploaded_at: iso(lastLog.uploaded_at)!, lines: lastLog.lines.slice(-200) } : null,
    events: events.rows.map((e) => ({ ...e, occurred_at: iso(e.occurred_at)!, received_at: iso(e.received_at)! })),
    alerts: await listAlerts(q, { registerId, openOnly: false, limit: 20 }),
  };
}

/** Maintenance: heartbeat history is operational data kept for 7 days. */
export async function pruneHeartbeats(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `WITH d AS (DELETE FROM register_heartbeats WHERE received_at < now() - interval '7 days' RETURNING 1) SELECT count(*)::int AS n FROM d`,
  );
  return rows[0]!.n;
}
