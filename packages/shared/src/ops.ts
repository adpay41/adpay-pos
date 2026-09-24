/**
 * Ops layer wire shapes (build plan P4 / F3, spec step 3): register heartbeat, device logs, remote
 * actions, alerts, and the WebSocket messages that carry them. Support is one person for the first
 * 200 stores; everything here exists so that person can see and fix a register without a truck roll.
 */
import { z } from 'zod';
import { Uuid } from './tenancy';

/** How often a register reports in, and when the office starts to worry. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** No heartbeat for this long: shown as "stale" on the device page. */
export const HEARTBEAT_STALE_MS = 90_000;
/** No heartbeat for this long: the register-offline alert opens (Bible 2.6: "offline > 5 min"). */
export const REGISTER_OFFLINE_ALERT_MS = 5 * 60_000;

/**
 * Health of one piece of hardware. `preview` = the browser build's stand-in (no real device yet);
 * `not_present` = this register has none (e.g. no card terminal paired).
 */
export const HardwareState = z.enum(['ok', 'warning', 'error', 'offline', 'not_present', 'preview', 'unknown']);
export type HardwareState = z.infer<typeof HardwareState>;

const HardwareSlot = z.strictObject({
  state: HardwareState,
  /** Short human detail: "paper low", "USB scanner", "PAX A35 10.0.0.23". Never card data. */
  detail: z.string().max(120).nullable(),
});
export type HardwareSlot = z.infer<typeof HardwareSlot>;

export const HARDWARE_SLOTS = ['printer', 'drawer', 'scanner', 'terminal', 'customer_display'] as const;
export type HardwareSlotName = (typeof HARDWARE_SLOTS)[number];

export const HeartbeatInput = z.strictObject({
  sent_at: z.iso.datetime({ offset: true }),
  app_version: z.string().min(1).max(40),
  build: z.string().max(80).nullable(),
  platform: z.enum(['android', 'web', 'ios']),
  uptime_s: z.int().min(0),
  network: z.strictObject({ online: z.boolean(), type: z.string().max(40).nullable() }),
  power: z.strictObject({ on_battery: z.boolean().nullable(), battery_pct: z.int().min(0).max(100).nullable() }),
  storage_free_mb: z.int().min(0).nullable(),
  sync: z.strictObject({
    queued: z.int().min(0),
    rejected: z.int().min(0),
    last_sync_at: z.iso.datetime({ offset: true }).nullable(),
    last_error: z.string().max(300).nullable(),
  }),
  /** The catalog/config version the register is running; compared with the server's for "config diff". */
  catalog_version: z.int().min(0).nullable(),
  signed_in_user_id: Uuid.nullable(),
  open_sale_id: Uuid.nullable(),
  ws_connected: z.boolean(),
  hardware: z.strictObject({
    printer: HardwareSlot,
    drawer: HardwareSlot,
    scanner: HardwareSlot,
    terminal: HardwareSlot,
    customer_display: HardwareSlot,
  }),
});
export type Heartbeat = z.infer<typeof HeartbeatInput>;

// ─────────────────────────────────────────────────────────── logs ──

export const LOG_RING_SIZE = 10_000;
export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

/** One line of the register's local log ring. `ctx` is small structured context; never PINs or card data. */
export const DeviceLogLine = z.strictObject({
  seq: z.int().min(0),
  at: z.iso.datetime({ offset: true }),
  level: LogLevel,
  msg: z.string().max(500),
  ctx: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).nullable(),
});
export type DeviceLogLine = z.infer<typeof DeviceLogLine>;

export const LogUploadInput = z.strictObject({
  action_id: Uuid.nullable(),
  lines: z.array(DeviceLogLine).max(LOG_RING_SIZE),
});

// ─────────────────────────────────────────────────────────── remote actions ──

/**
 * What the office can ask a register to do (spec: "restart app, force sync, reprint, re-pair
 * terminal, printer test, push config, roll back build"). The last three need the device module /
 * MDM (build plan P-HW); a browser register answers them `unsupported` rather than pretending.
 */
export const REMOTE_ACTIONS = {
  restart_app: { label: 'Restart app', needs: null },
  force_sync: { label: 'Force sync', needs: null },
  push_config: { label: 'Push config', needs: null },
  upload_logs: { label: 'Fetch logs', needs: null },
  reprint: { label: 'Reprint receipt', needs: null },
  printer_test: { label: 'Printer test', needs: null },
  sign_out: { label: 'Sign cashier out', needs: null },
  repair_terminal: { label: 'Re-pair terminal', needs: 'PAX A35 + Finix (P-HW)' },
  rollback_build: { label: 'Roll back build', needs: 'OTA / MDM decision (P-HW)' },
  reboot_device: { label: 'Reboot device', needs: 'Device Owner module (P-HW)' },
} as const;
export type RemoteActionKind = keyof typeof REMOTE_ACTIONS;
export const RemoteActionKindSchema = z.enum(Object.keys(REMOTE_ACTIONS) as [RemoteActionKind, ...RemoteActionKind[]]);

export const RemoteActionRequest = z
  .strictObject({
    kind: RemoteActionKindSchema,
    params: z.strictObject({ sale_id: Uuid.optional() }).default({}),
  })
  .refine((a) => a.kind !== 'reprint' || !!a.params.sale_id, { message: 'Reprint needs a sale_id', path: ['params', 'sale_id'] });

export type RemoteActionStatus = 'queued' | 'delivered' | 'succeeded' | 'failed' | 'unsupported' | 'expired';

export interface RemoteAction {
  action_id: string;
  register_id: string;
  kind: RemoteActionKind;
  params: { sale_id?: string };
  status: RemoteActionStatus;
  requested_at: string;
  requested_by_name: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  result: { message: string } | null;
}

export const ActionResultInput = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'unsupported']),
  message: z.string().max(500),
});

/** What the API answers a heartbeat with: actions waiting for this register (the WebSocket is a fast path). */
export interface HeartbeatResponse {
  server_time: string;
  catalog_version: number;
  actions: RemoteAction[];
}

// ─────────────────────────────────────────────────────────── alerts ──

export const ALERT_RULES = {
  register_offline: { label: 'Register offline', severity: 'critical', merchant: true },
  queue_stuck: { label: 'Sales not reaching the server', severity: 'warning', merchant: false },
  events_rejected: { label: 'Events rejected by the server', severity: 'warning', merchant: false },
  pin_lockout: { label: 'PIN lockout at the register', severity: 'warning', merchant: true },
  hardware_error: { label: 'Printer / scanner / terminal problem', severity: 'warning', merchant: true },
  high_void_rate: { label: 'Unusually many voids today', severity: 'warning', merchant: true },
  drawer_short: { label: 'Drawer counted short', severity: 'warning', merchant: true },
  no_sale_spike: { label: 'Drawer opened without a sale, many times', severity: 'warning', merchant: true },
} as const;
export type AlertRule = keyof typeof ALERT_RULES;
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  alert_id: string;
  rule: AlertRule;
  severity: AlertSeverity;
  title: string;
  details: Record<string, unknown>;
  merchant_id: string | null;
  merchant_name: string | null;
  location_name: string | null;
  register_id: string | null;
  register_name: string | null;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
}

// ─────────────────────────────────────────────────────────── device page ──

export type RegisterHealth = 'online' | 'stale' | 'offline' | 'never';

export function registerHealth(lastHeartbeatAt: string | null, now: number = Date.now()): RegisterHealth {
  if (!lastHeartbeatAt) return 'never';
  const age = now - Date.parse(lastHeartbeatAt);
  if (age <= HEARTBEAT_STALE_MS) return 'online';
  if (age <= REGISTER_OFFLINE_ALERT_MS) return 'stale';
  return 'offline';
}

export interface FleetRow {
  register_id: string;
  register_name: string;
  status: 'unpaired' | 'active' | 'retired';
  merchant_id: string;
  merchant_name: string;
  location_id: string;
  location_name: string;
  last_heartbeat_at: string | null;
  app_version: string | null;
  platform: string | null;
  queued: number | null;
  last_sync_at: string | null;
  device_catalog_version: number | null;
  server_catalog_version: number;
  ws_connected: boolean;
  open_alerts: number;
  hardware: Heartbeat['hardware'] | null;
}

export interface DevicePage extends FleetRow {
  heartbeat: Heartbeat | null;
  signed_in_name: string | null;
  recent_heartbeats: { received_at: string; queued: number; online: boolean }[];
  actions: RemoteAction[];
  logs: { uploaded_at: string; lines: DeviceLogLine[] } | null;
  events: { event_id: string; type: string; sale_id: string | null; occurred_at: string; received_at: string; actor_name: string | null }[];
  alerts: Alert[];
}

// ─────────────────────────────────────────────────────────── realtime ──

/** Messages the server pushes over `/ws`. The client authenticates with its first message. */
export type ServerMessage =
  | { type: 'ready'; kind: 'device' | 'merchant_user' | 'admin' }
  | { type: 'catalog'; catalog_version: number }
  | { type: 'action'; action: RemoteAction }
  | { type: 'sale'; merchant_id: string; register_id: string; sale_id: string; total_cents: number; price_mode: 'cash' | 'card'; at: string; actor_user_id: string | null }
  | { type: 'register'; register_id: string; merchant_id: string; last_heartbeat_at: string }
  | { type: 'alert'; alert: Alert }
  | { type: 'error'; message: string };

export const ClientAuthMessage = z.strictObject({ type: z.literal('auth'), token: z.string().min(10).max(4000) });
