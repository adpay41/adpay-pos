/**
 * Realtime channel (build plan P4 / F3; spec: "WebSockets for live pushes"). One endpoint, `/ws`:
 *
 *  - The client authenticates with its **first message** `{type:'auth', token}` (device token or
 *    user JWT). Tokens never go in the URL, because URLs end up in logs.
 *  - Registers get `catalog` nudges (a price change arrives in about a second, not on the next 15 s
 *    poll) and `action`s from the remote-action queue.
 *  - Merchant users get their own merchant's `sale`, `register` and merchant-facing `alert` messages;
 *    AD Pay admins get everything.
 *
 * Changes arrive through Postgres LISTEN/NOTIFY, sent on commit by triggers and services, so this
 * works the same with one API instance or several. The socket is only a fast path: every message
 * has a polling fallback (heartbeat replies, catalog version checks), so a register behind a proxy
 * that drops WebSockets still works.
 */
import websocket from '@fastify/websocket';
import { ALERT_RULES, ClientAuthMessage, type ServerMessage } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import type pino from 'pino';
import type { WebSocket } from 'ws';
import type { Principal } from '../auth/principal';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { resolvePrincipal } from '../http/auth-hooks';
import { listAlerts } from '../services/alerts';
import { deliverAction, setWsConnected, takePendingActions } from '../services/ops';

const AUTH_TIMEOUT_MS = 10_000;
const PING_MS = 25_000;

interface Client {
  socket: WebSocket;
  principal: Principal;
  alive: boolean;
}

export class RealtimeHub {
  private clients = new Set<Client>();
  private stops: (() => Promise<void>)[] = [];
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: pino.Logger,
  ) {}

  async register(app: FastifyInstance): Promise<void> {
    await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
    app.get('/ws', { websocket: true }, (socket) => this.accept(socket));
    if (this.db.listen) {
      this.stops.push(await this.db.listen('adpay_catalog', (p) => void this.onCatalog(p)));
      this.stops.push(await this.db.listen('adpay_action', (p) => void this.onAction(p)));
      this.stops.push(await this.db.listen('adpay_sale', (p) => this.onSale(p)));
      this.stops.push(await this.db.listen('adpay_register', (p) => this.onRegister(p)));
      this.stops.push(await this.db.listen('adpay_alert', (p) => void this.onAlert(p)));
    }
    this.ping = setInterval(() => this.heartbeat(), PING_MS);
    app.addHook('onClose', async () => {
      if (this.ping) clearInterval(this.ping);
      for (const stop of this.stops) await stop();
      for (const c of this.clients) c.socket.close(1001, 'server shutting down');
    });
  }

  /** Connected clients by kind, for /health and tests. */
  counts(): { device: number; merchant_user: number; admin: number } {
    const n = { device: 0, merchant_user: 0, admin: 0 };
    for (const c of this.clients) n[c.principal.kind]++;
    return n;
  }

  private send(c: Client, msg: ServerMessage) {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }

  private accept(socket: WebSocket) {
    let client: Client | null = null;
    const timer = setTimeout(() => socket.close(4401, 'authenticate first'), AUTH_TIMEOUT_MS);
    socket.on('message', async (raw) => {
      if (client) return; // After auth the channel is server → client only.
      clearTimeout(timer);
      const principal = await this.authenticate(String(raw));
      if (!principal) {
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' } satisfies ServerMessage));
        socket.close(4401, 'unauthorized');
        return;
      }
      client = { socket, principal, alive: true };
      this.clients.add(client);
      socket.on('pong', () => {
        if (client) client.alive = true;
      });
      this.send(client, { type: 'ready', kind: principal.kind });
      if (principal.kind === 'device') await this.onDeviceConnected(client, principal.register_id, principal.merchant_id);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!client) return;
      this.clients.delete(client);
      const p = client.principal;
      if (p.kind === 'device' && !this.deviceConnected(p.register_id)) {
        void setWsConnected(this.db, p.register_id, false).catch(() => undefined);
      }
    });
    socket.on('error', () => socket.terminate());
  }

  /** The first frame must be `{type:'auth', token}`; anything else (or a bad token) is null. */
  private async authenticate(raw: string): Promise<Principal | null> {
    try {
      return await resolvePrincipal(this.db, this.config, ClientAuthMessage.parse(JSON.parse(raw)).token);
    } catch {
      return null;
    }
  }

  private deviceConnected(registerId: string): boolean {
    for (const c of this.clients) if (c.principal.kind === 'device' && c.principal.register_id === registerId) return true;
    return false;
  }

  /** On connect: mark it, send the current catalog version, and hand over anything queued. */
  private async onDeviceConnected(c: Client, registerId: string, merchantId: string) {
    try {
      await setWsConnected(this.db, registerId, true);
      const { rows } = await this.db.query<{ catalog_version: number }>('SELECT catalog_version FROM merchants WHERE merchant_id = $1', [merchantId]);
      if (rows[0]) this.send(c, { type: 'catalog', catalog_version: rows[0].catalog_version });
      for (const action of await takePendingActions(this.db, registerId)) this.send(c, { type: 'action', action });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, register_id: registerId }, 'ws device setup failed');
    }
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  private where(pred: (p: Principal) => boolean): Client[] {
    return [...this.clients].filter((c) => pred(c.principal));
  }

  private async onCatalog(payload: string) {
    const { merchant_id, catalog_version } = JSON.parse(payload) as { merchant_id: string; catalog_version: number };
    for (const c of this.where((p) => p.kind === 'device' && p.merchant_id === merchant_id)) this.send(c, { type: 'catalog', catalog_version });
  }

  private async onAction(payload: string) {
    const { action_id, register_id } = JSON.parse(payload) as { action_id: string; register_id: string };
    const targets = this.where((p) => p.kind === 'device' && p.register_id === register_id);
    if (targets.length === 0) return; // Delivered with the next heartbeat instead.
    const action = await deliverAction(this.db, action_id);
    if (action) for (const c of targets) this.send(c, { type: 'action', action });
  }

  private forMerchant(merchantId: string): Client[] {
    return this.where((p) => p.kind === 'admin' || (p.kind === 'merchant_user' && p.merchant_id === merchantId));
  }

  private onSale(payload: string) {
    const sale = JSON.parse(payload) as Extract<ServerMessage, { type: 'sale' }>;
    // Sales figures only for people allowed to see them.
    for (const c of this.forMerchant(sale.merchant_id)) {
      if (c.principal.kind === 'merchant_user' && !c.principal.permissions.includes('reports.view')) continue;
      this.send(c, { ...sale, type: 'sale' });
    }
  }

  private onRegister(payload: string) {
    const r = JSON.parse(payload) as { register_id: string; merchant_id: string; last_heartbeat_at: string };
    for (const c of this.forMerchant(r.merchant_id)) this.send(c, { type: 'register', ...r });
  }

  private async onAlert(payload: string) {
    const { alert_id } = JSON.parse(payload) as { alert_id: string };
    const [alert] = await listAlerts(this.db, { ids: [alert_id], openOnly: false, limit: 1 });
    if (!alert) return;
    for (const c of this.where((p) => p.kind === 'admin')) this.send(c, { type: 'alert', alert });
    if (alert.merchant_id && ALERT_RULES[alert.rule].merchant && !alert.muted) {
      for (const c of this.where((p) => p.kind === 'merchant_user' && p.merchant_id === alert.merchant_id)) this.send(c, { type: 'alert', alert });
    }
  }
}
