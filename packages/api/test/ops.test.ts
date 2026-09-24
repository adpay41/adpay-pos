/**
 * Phase 4: the ops layer. Heartbeat, remote actions, logs, alert rules, and the realtime channel.
 * Runs on real Postgres in CI (LISTEN/NOTIFY included).
 */
import { randomUUID } from 'node:crypto';
import type { Alert, DevicePage, FleetRow, Heartbeat, HeartbeatResponse, ServerMessage } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { Db } from '../db/db';
import { evaluateAlerts } from '../services/alerts';
import { auth, cashSaleEvents, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, testBackend, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let admin: string;
let ownerA: string;
let ownerB: string;
let deviceA: string;
let deviceB: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await app.ready();
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  await createAdmin(db);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token;
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
  deviceB = await pairDevice(app, db, b.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function heartbeat(over: Partial<Heartbeat> = {}): Heartbeat {
  const slot = { state: 'preview' as const, detail: null };
  return {
    sent_at: new Date().toISOString(),
    app_version: '0.4.0',
    build: 'web-dev',
    platform: 'web',
    uptime_s: 120,
    network: { online: true, type: 'wifi' },
    power: { on_battery: null, battery_pct: null },
    storage_free_mb: 2048,
    sync: { queued: 0, rejected: 0, last_sync_at: new Date().toISOString(), last_error: null },
    catalog_version: 1,
    signed_in_user_id: null,
    open_sale_id: null,
    ws_connected: false,
    hardware: { printer: slot, drawer: slot, scanner: slot, terminal: { state: 'not_present', detail: null }, customer_display: slot },
    ...over,
  };
}

const beat = (token: string, hb: Heartbeat = heartbeat()) => app.inject({ method: 'POST', url: '/device/heartbeat', headers: auth(token), payload: hb });
const page = async (registerId: string): Promise<DevicePage> => (await app.inject({ method: 'GET', url: `/admin/registers/${registerId}`, headers: auth(admin) })).json();
const ask = (registerId: string, body: object, token = admin) =>
  app.inject({ method: 'POST', url: `/admin/registers/${registerId}/actions`, headers: auth(token), payload: body });

describe('heartbeat and device page', () => {
  it('stores the heartbeat; the fleet list and device page show it, with the config diff', async () => {
    const r = await beat(deviceA, heartbeat({ catalog_version: 0, sync: { queued: 3, rejected: 0, last_sync_at: null, last_error: 'offline' } }));
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as HeartbeatResponse;
    expect(body.actions).toEqual([]);
    expect(body.catalog_version).toBeGreaterThan(0);

    const fleet = (await app.inject({ method: 'GET', url: '/admin/fleet', headers: auth(admin) })).json().registers as FleetRow[];
    const row = fleet.find((f) => f.register_id === a.register_id)!;
    expect(row).toMatchObject({ app_version: '0.4.0', platform: 'web', queued: 3, device_catalog_version: 0 });
    expect(row.server_catalog_version).toBe(body.catalog_version); // device is behind: the page shows the diff

    const p = await page(a.register_id);
    expect(p.heartbeat?.sync.last_error).toBe('offline');
    expect(p.recent_heartbeats.length).toBeGreaterThan(0);
  });

  it('is strict: a field the schema does not know (like card data) is a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/device/heartbeat', headers: auth(deviceA), payload: { ...heartbeat(), pan: '4111111111111111' } });
    expect(r.statusCode).toBe(400);
  });

  it('merchants see their own registers only; devices and merchants cannot use the admin routes', async () => {
    const mine = (await app.inject({ method: 'GET', url: '/merchant/registers', headers: auth(ownerA) })).json().registers as FleetRow[];
    expect(mine.every((r) => r.merchant_id === a.merchant_id)).toBe(true);
    expect(mine.some((r) => r.register_id === a.register_id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/admin/fleet', headers: auth(ownerA) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/admin/registers/${a.register_id}`, headers: auth(deviceA) })).statusCode).toBe(403);
  });
});

describe('remote actions', () => {
  it('queued by admin (audited) → handed out on the next heartbeat → result reported once', async () => {
    const q = await ask(a.register_id, { kind: 'force_sync' });
    expect(q.statusCode, q.body).toBe(201);
    const { action_id } = q.json();
    const { rows } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'register.remote_action' AND target = $1`, [action_id]);
    expect(rows).toHaveLength(1);

    const hb = (await beat(deviceA)).json() as HeartbeatResponse;
    expect(hb.actions.map((x) => [x.action_id, x.kind, x.status])).toEqual([[action_id, 'force_sync', 'delivered']]);
    expect(((await beat(deviceA)).json() as HeartbeatResponse).actions).toEqual([]); // handed out once

    // Another register can't report on it; this one can, once.
    expect((await app.inject({ method: 'POST', url: `/device/actions/${action_id}/result`, headers: auth(deviceB), payload: { status: 'succeeded', message: 'x' } })).statusCode).toBe(404);
    const done = await app.inject({ method: 'POST', url: `/device/actions/${action_id}/result`, headers: auth(deviceA), payload: { status: 'succeeded', message: 'Synced 3 events' } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'succeeded', result: { message: 'Synced 3 events' } });
    expect((await app.inject({ method: 'POST', url: `/device/actions/${action_id}/result`, headers: auth(deviceA), payload: { status: 'failed', message: 'x' } })).statusCode).toBe(404);

    const p = await page(a.register_id);
    expect(p.actions[0]).toMatchObject({ action_id, status: 'succeeded', requested_by_name: 'Test Admin' });
  });

  it('a reprint must name a sale rung on that register', async () => {
    expect((await ask(a.register_id, { kind: 'reprint' })).statusCode).toBe(400);
    expect((await ask(a.register_id, { kind: 'reprint', params: { sale_id: randomUUID() } })).statusCode).toBe(400);
    const sale = cashSaleEvents(a);
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events: sale.events } });
    expect((await ask(a.register_id, { kind: 'reprint', params: { sale_id: sale.sale_id } })).statusCode).toBe(201);
  });

  it('refuses unknown kinds and unpaired registers', async () => {
    expect((await ask(a.register_id, { kind: 'format_disk' })).statusCode).toBe(400);
    const { rows } = await db.query<{ register_id: string }>(
      `INSERT INTO registers (org_id, merchant_id, location_id, name) VALUES ($1, $2, $3, 'Spare') RETURNING register_id`,
      [a.org_id, a.merchant_id, a.location_id],
    );
    expect((await ask(rows[0]!.register_id, { kind: 'force_sync' })).statusCode).toBe(400);
  });
});

describe('device logs', () => {
  it('stores an upload; the device page shows the last 200 lines', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({ seq: i, at: new Date().toISOString(), level: 'info' as const, msg: `line ${i}`, ctx: null }));
    const r = await app.inject({ method: 'POST', url: '/device/logs', headers: auth(deviceA), payload: { action_id: null, lines } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().line_count).toBe(250);
    const p = await page(a.register_id);
    expect(p.logs!.lines).toHaveLength(200);
    expect(p.logs!.lines.at(-1)!.msg).toBe('line 249');
  });
});

describe('alert rules', () => {
  const open = async (token: string, url = '/admin/alerts'): Promise<Alert[]> => (await app.inject({ method: 'GET', url, headers: auth(token) })).json().alerts;

  it('register offline > 5 min opens once, stays open, and resolves when heartbeats resume', async () => {
    await beat(deviceB);
    const later = new Date(Date.now() + 6 * 60_000);
    const first = await evaluateAlerts(db, null, later);
    const mine = first.opened.filter((x) => x.rule === 'register_offline' && x.register_id === b.register_id);
    expect(mine).toHaveLength(1);
    expect((await evaluateAlerts(db, null, later)).opened.filter((x) => x.register_id === b.register_id && x.rule === 'register_offline')).toHaveLength(0);

    // Merchant B sees it in their inbox, A doesn't; A can't acknowledge it.
    expect((await open(ownerB, '/merchant/alerts')).some((x) => x.alert_id === mine[0]!.alert_id)).toBe(true);
    expect((await open(ownerA, '/merchant/alerts')).some((x) => x.alert_id === mine[0]!.alert_id)).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/merchant/alerts/${mine[0]!.alert_id}/ack`, headers: auth(ownerA) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/merchant/alerts/${mine[0]!.alert_id}/ack`, headers: auth(ownerB) })).statusCode).toBe(200);

    await beat(deviceB);
    await evaluateAlerts(db, null, new Date());
    const after = await open(admin);
    expect(after.some((x) => x.alert_id === mine[0]!.alert_id)).toBe(false);
  });

  it('hardware errors, stuck queues and rejected events open their own alerts', async () => {
    await beat(
      deviceA,
      heartbeat({
        hardware: { ...heartbeat().hardware, printer: { state: 'error', detail: 'paper out' } },
        sync: { queued: 12, rejected: 2, last_sync_at: new Date(Date.now() - 30 * 60_000).toISOString(), last_error: 'HTTP 502' },
      }),
    );
    const r = await evaluateAlerts(db, null, new Date());
    const rules = r.opened.filter((x) => x.register_id === a.register_id).map((x) => x.rule).sort();
    expect(rules).toEqual(['events_rejected', 'hardware_error', 'queue_stuck']);
    expect(r.opened.find((x) => x.rule === 'hardware_error')!.title).toContain('paper out');
    // Stuck queues are for AD Pay support; merchants aren't shown them.
    const merchant = await open(ownerA, '/merchant/alerts');
    expect(merchant.some((x) => x.rule === 'hardware_error')).toBe(true);
    expect(merchant.some((x) => x.rule === 'queue_stuck')).toBe(false);
    await beat(deviceA); // healthy again
    await evaluateAlerts(db, null, new Date());
  });

  it('a PIN lockout at the register raises an alert naming the person', async () => {
    const user = (await db.query<{ user_id: string }>('SELECT user_id FROM memberships WHERE merchant_id = $1 LIMIT 1', [a.merchant_id])).rows[0]!.user_id;
    const e = {
      event_id: randomUUID(), schema_version: 1, sale_id: null, device_seq: 5000, occurred_at: new Date().toISOString(),
      org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id, trace_id: 't',
      actor_user_id: null, type: 'staff.pin_failed', payload: { user_id: user, purpose: 'sign_in', failures: 5, locked: true },
    };
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events: [e] } });
    const r = await evaluateAlerts(db, null, new Date());
    expect(r.opened.find((x) => x.rule === 'pin_lockout')!.title).toContain('Alpha Owner');
  });
});

describe.skipIf(testBackend() !== 'postgres')('realtime channel (/ws)', () => {
  function collect(ws: WebSocket) {
    const got: ServerMessage[] = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m)) as ServerMessage));
    return {
      got,
      next: (pred: (m: ServerMessage) => boolean, ms = 3000) =>
        new Promise<ServerMessage>((resolve, reject) => {
          const t0 = Date.now();
          const tick = () => {
            const hit = got.find(pred);
            if (hit) return resolve(hit);
            if (Date.now() - t0 > ms) return reject(new Error(`timeout; got ${JSON.stringify(got)}`));
            setTimeout(tick, 25);
          };
          tick();
        }),
    };
  }
  async function connect(token: string) {
    const ws = await app.injectWS('/ws');
    const c = collect(ws);
    ws.send(JSON.stringify({ type: 'auth', token }));
    await c.next((m) => m.type === 'ready');
    return { ws, ...c };
  }

  it('refuses a socket that does not authenticate', async () => {
    const ws = await app.injectWS('/ws');
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'auth', token: 'dev_not-a-real-token-at-all' }));
    expect(await closed).toBe(4401);
  });

  it('a register gets a catalog nudge the moment a price changes, and remote actions pushed', async () => {
    const dev = await connect(deviceA);
    await dev.next((m) => m.type === 'catalog'); // current version on connect
    const before = dev.got.length;

    const item = (await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(ownerA) })).json().items[0];
    const upd = await app.inject({ method: 'PATCH', url: `/merchant/items/${item.item_id}`, headers: auth(ownerA), payload: { cash_price_cents: item.cash_price_cents + 10 } });
    const nudge = await dev.next((m, i = dev.got.indexOf(m)) => i >= before && m.type === 'catalog');
    expect(nudge).toMatchObject({ type: 'catalog', catalog_version: upd.json().catalog_version });

    const { action_id } = (await ask(a.register_id, { kind: 'upload_logs' })).json();
    const pushed = await dev.next((m) => m.type === 'action' && m.action.action_id === action_id);
    expect(pushed.type === 'action' && pushed.action.status).toBe('delivered');
    expect(((await beat(deviceA)).json() as HeartbeatResponse).actions).toEqual([]); // not handed out twice
    dev.ws.terminate();
  });

  it('merchant users get their own sales live; other merchants do not', async () => {
    const mineWs = await connect(ownerA);
    const otherWs = await connect(ownerB);
    const sale = cashSaleEvents(a, { seqStart: 7000 });
    await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events: sale.events } });
    const live = await mineWs.next((m) => m.type === 'sale' && m.sale_id === sale.sale_id);
    expect(live).toMatchObject({ type: 'sale', register_id: a.register_id, price_mode: 'cash' });
    await new Promise((r) => setTimeout(r, 300));
    expect(otherWs.got.some((m) => m.type === 'sale' && m.sale_id === sale.sale_id)).toBe(false);
    mineWs.ws.terminate();
    otherWs.ws.terminate();
  });
});
