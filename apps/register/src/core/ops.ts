/**
 * The register's side of the ops layer (build plan P4 / F3, spec step 3):
 *  - DeviceLog: a local ring of the last 10k log lines (never PINs, never card data), uploaded when
 *    the office asks;
 *  - OpsAgent: a heartbeat every 30 s, a WebSocket for instant catalog nudges and remote actions, and
 *    the executor that runs those actions and reports how they went.
 *
 * None of this is on the sale path. If the API or the socket is down, heartbeats simply fail and the
 * register keeps selling (ADR 0002). Actions arrive by socket or in the heartbeat reply, whichever
 * comes first, and each runs once.
 */
import {
  HEARTBEAT_INTERVAL_MS,
  REMOTE_ACTIONS,
  type DeviceLogLine,
  type HardwareSlot,
  type HardwareSlotName,
  type Heartbeat,
  type HeartbeatResponse,
  type LogLevel,
  type RemoteAction,
  type ServerMessage,
} from '@adpay/shared';
import type { SaleSession } from './session';
import type { StaffGate } from './staff';
import type { EventStore } from './store';
import type { SyncEngine, SyncStatus } from './sync';

export class DeviceLog {
  constructor(
    private readonly store: EventStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(level: LogLevel, msg: string, ctx: DeviceLogLine['ctx'] = null): void {
    void this.store.appendLog({ at: this.now().toISOString(), level, msg: msg.slice(0, 500), ctx }).catch(() => undefined);
  }
  info(msg: string, ctx?: DeviceLogLine['ctx']) {
    this.write('info', msg, ctx);
  }
  warn(msg: string, ctx?: DeviceLogLine['ctx']) {
    this.write('warn', msg, ctx);
  }
  error(msg: string, ctx?: DeviceLogLine['ctx']) {
    this.write('error', msg, ctx);
  }
}

export interface OpsTransport {
  heartbeat(hb: Heartbeat): Promise<HeartbeatResponse>;
  uploadLogs(actionId: string | null, lines: DeviceLogLine[]): Promise<void>;
  actionResult(actionId: string, status: 'succeeded' | 'failed' | 'unsupported', message: string): Promise<void>;
}

/** Actions that need the screen or the hardware; the UI provides them once it is mounted. */
export interface ActionHandlers {
  reprint?(saleId: string): Promise<string>;
  printerTest?(): Promise<string>;
  restartApp?(): void;
}

export interface OpsDeps {
  store: EventStore;
  sync: SyncEngine;
  session: SaleSession;
  staff: StaffGate;
  log: DeviceLog;
  transport: OpsTransport;
  hardware: () => Record<HardwareSlotName, HardwareSlot>;
  appVersion: string;
  build: string | null;
  platform: Heartbeat['platform'];
  /** Opens the realtime socket; null in tests or where there is no WebSocket. */
  openSocket: (() => WebSocket) | null;
  deviceToken: string;
  environment?: () => { networkType: string | null; storageFreeMb: number | null };
  now?: () => Date;
}

export class OpsAgent {
  private timer: ReturnType<typeof setInterval> | null = null;
  private socket: WebSocket | null = null;
  private socketBackoff = 2_000;
  private stopped = false;
  private sync: SyncStatus | null = null;
  private handled = new Set<string>();
  private handlers: ActionHandlers = {};
  private readonly started: number;
  private readonly now: () => Date;

  constructor(private readonly d: OpsDeps) {
    this.now = d.now ?? (() => new Date());
    this.started = this.now().getTime();
    d.sync.subscribe((s) => {
      if (this.sync && this.sync.online !== s.online) d.log.warn(s.online ? 'server reachable again' : 'server unreachable; selling offline', { queued: s.queued });
      if (s.lastError && s.lastError !== this.sync?.lastError) d.log.warn('sync error', { error: s.lastError.slice(0, 200) });
      this.sync = s;
    });
  }

  setHandlers(h: ActionHandlers): void {
    this.handlers = { ...this.handlers, ...h };
  }

  start(): void {
    this.stopped = false;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
  }

  socketOpen(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  async heartbeat(): Promise<Heartbeat> {
    const counts = await this.d.store.counts();
    const env = this.d.environment?.() ?? { networkType: null, storageFreeMb: null };
    return {
      sent_at: this.now().toISOString(),
      app_version: this.d.appVersion,
      build: this.d.build,
      platform: this.d.platform,
      uptime_s: Math.max(0, Math.floor((this.now().getTime() - this.started) / 1000)),
      network: { online: this.sync?.online ?? false, type: env.networkType },
      power: { on_battery: null, battery_pct: null },
      storage_free_mb: env.storageFreeMb,
      sync: { queued: counts.queued, rejected: counts.rejected, last_sync_at: this.sync?.lastSyncAt ?? null, last_error: this.sync?.lastError?.slice(0, 300) ?? null },
      catalog_version: this.sync?.catalogVersion ?? (await this.d.sync.cachedCatalog())?.catalog_version ?? null,
      signed_in_user_id: this.d.staff.state().member?.user_id ?? null,
      open_sale_id: this.d.session.state().sale?.sale_id ?? null,
      ws_connected: this.socketOpen(),
      hardware: this.d.hardware(),
    };
  }

  /** One heartbeat; runs any actions in the reply. Failures are expected offline and only logged. */
  async beat(): Promise<HeartbeatResponse | null> {
    try {
      const res = await this.d.transport.heartbeat(await this.heartbeat());
      for (const a of res.actions) await this.execute(a);
      return res;
    } catch {
      return null;
    }
  }

  /** Run one remote action (at most once per id) and report the outcome. */
  async execute(a: RemoteAction): Promise<void> {
    if (this.handled.has(a.action_id)) return;
    this.handled.add(a.action_id);
    this.d.log.info('remote action', { kind: a.kind, action_id: a.action_id, by: a.requested_by_name });
    let outcome: Outcome;
    try {
      outcome = await this.perform(a);
    } catch (e) {
      outcome = { status: e instanceof Unsupported ? 'unsupported' : 'failed', message: (e as Error).message.slice(0, 500) };
      this.d.log.warn('remote action did not complete', { kind: a.kind, status: outcome.status, message: outcome.message });
    }
    await this.d.transport.actionResult(a.action_id, outcome.status, outcome.message).catch(() => undefined);
    // Restart only after the office has heard back, or the result would be lost.
    outcome.after?.();
  }

  private async perform(a: RemoteAction): Promise<Outcome> {
    switch (a.kind) {
      case 'force_sync': {
        const pushed = await this.d.sync.pushOnce();
        await this.d.sync.refreshCatalogIfStale();
        const counts = await this.d.store.counts();
        return { status: 'succeeded', message: `Pushed ${pushed} events; ${counts.queued} still queued` };
      }
      case 'push_config': {
        // pullCatalog falls back to the cached copy offline; only a fresh pull counts as success.
        const c = await this.d.sync.pullCatalog();
        return c && this.sync?.online
          ? { status: 'succeeded', message: `Catalog v${c.catalog_version} loaded` }
          : { status: 'failed', message: 'Could not reach the server; kept the cached catalog' };
      }
      case 'upload_logs': {
        const lines = await this.d.store.recentLogs(2_000);
        await this.d.transport.uploadLogs(a.action_id, lines);
        return { status: 'succeeded', message: `Uploaded ${lines.length} lines` };
      }
      case 'sign_out': {
        const who = this.d.staff.state().member?.name ?? null;
        await this.d.staff.signOut('manual');
        return { status: 'succeeded', message: who ? `Signed out ${who}` : 'Nobody was signed in' };
      }
      case 'reprint':
        if (!this.handlers.reprint || !a.params.sale_id) throw new Unsupported('Reprint is available once the sale screen is open');
        return { status: 'succeeded', message: await this.handlers.reprint(a.params.sale_id) };
      case 'printer_test':
        if (!this.handlers.printerTest) throw new Unsupported('No printer on this register');
        return { status: 'succeeded', message: await this.handlers.printerTest() };
      case 'restart_app':
        if (!this.handlers.restartApp) throw new Unsupported('This build cannot restart itself');
        return { status: 'succeeded', message: 'Restarting', after: this.handlers.restartApp };
      default:
        throw new Unsupported(`${REMOTE_ACTIONS[a.kind].label} needs ${REMOTE_ACTIONS[a.kind].needs ?? 'the device module'}`);
    }
  }

  private connect() {
    if (this.stopped || !this.d.openSocket) return;
    let ws: WebSocket;
    try {
      ws = this.d.openSocket();
    } catch {
      this.retry();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.d.deviceToken }));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        this.socketBackoff = 2_000;
        this.d.log.info('realtime channel connected');
      } else if (msg.type === 'catalog') {
        if (msg.catalog_version !== this.sync?.catalogVersion) void this.d.sync.refreshCatalogIfStale();
      } else if (msg.type === 'action') {
        void this.execute(msg.action);
      }
    };
    ws.onclose = () => {
      if (this.socket === ws) this.socket = null;
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.socketBackoff);
    this.socketBackoff = Math.min(30_000, this.socketBackoff * 2);
  }
}

class Unsupported extends Error {}

interface Outcome {
  status: 'succeeded' | 'failed' | 'unsupported';
  message: string;
  after?: () => void;
}
