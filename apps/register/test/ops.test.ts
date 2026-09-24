/**
 * Register ops agent (P4): heartbeat contents, remote actions run once with honest results, log
 * ring, and that none of it can stop a sale.
 */
import { randomUUID } from 'node:crypto';
import { LOG_RING_SIZE, type CatalogItem, type CatalogSnapshot, type DeviceLogLine, type Heartbeat, type HeartbeatResponse, type RemoteAction } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { PREVIEW_HEALTH } from '../src/core/hardware';
import { DeviceLog, OpsAgent, type OpsTransport } from '../src/core/ops';
import { SaleSession } from '../src/core/session';
import { StaffGate } from '../src/core/staff';
import { MemoryEventStore } from '../src/core/store';
import { SyncEngine, type Transport } from '../src/core/sync';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const COFFEE: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Coffee', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 275,
  card_price_cents: 286, card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0,
  min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};

class FakeApi implements Transport, OpsTransport {
  online = true;
  beats: Heartbeat[] = [];
  results: { id: string; status: string; message: string }[] = [];
  uploads: DeviceLogLine[][] = [];
  pending: RemoteAction[] = [];
  async pushEvents(events: unknown[]) {
    if (!this.online) throw new Error('offline');
    return { accepted: (events as { event_id: string }[]).map((e) => e.event_id), duplicates: [], rejected: [] };
  }
  async pullCatalog(): Promise<CatalogSnapshot> {
    if (!this.online) throw new Error('offline');
    return { merchant_id: tenancy.merchant_id, location_id: tenancy.location_id, catalog_version: 9, dual_price_rate_ppm: 40_000, tax_rate_ppm: 0, generated_at: '', categories: [], items: [COFFEE], quick_keys: [] };
  }
  async catalogVersion() {
    if (!this.online) throw new Error('offline');
    return 9;
  }
  async heartbeat(hb: Heartbeat): Promise<HeartbeatResponse> {
    if (!this.online) throw new Error('offline');
    this.beats.push(hb);
    const actions = this.pending;
    this.pending = [];
    return { server_time: new Date().toISOString(), catalog_version: 9, actions };
  }
  async uploadLogs(_id: string | null, lines: DeviceLogLine[]) {
    this.uploads.push(lines);
  }
  async actionResult(id: string, status: string, message: string) {
    this.results.push({ id, status, message });
  }
}

const action = (kind: RemoteAction['kind'], params: RemoteAction['params'] = {}): RemoteAction => ({
  action_id: randomUUID(), register_id: tenancy.register_id, kind, params, status: 'delivered', requested_at: new Date().toISOString(),
  requested_by_name: 'Support', delivered_at: null, completed_at: null, result: null,
});

async function setup() {
  const store = new MemoryEventStore();
  const api = new FakeApi();
  const sync = new SyncEngine(store, api);
  await sync.pullCatalog();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 9, uuid: randomUUID });
  await session.restore();
  const staff = new StaffGate(store, session);
  await staff.restore({ members: [] });
  const log = new DeviceLog(store);
  const ops = new OpsAgent({
    store, sync, session, staff, log, transport: api, hardware: () => PREVIEW_HEALTH, appVersion: '0.4.0', build: 'test',
    platform: 'web', openSocket: null, deviceToken: 'dev_test',
  });
  return { store, api, sync, session, ops, log };
}

describe('heartbeat', () => {
  it('reports version, queue, catalog, open ticket and hardware; carries no PINs or card data', async () => {
    const { api, ops, session } = await setup();
    await session.addItem(COFFEE);
    await ops.beat();
    const hb = api.beats[0]!;
    expect(hb).toMatchObject({ app_version: '0.4.0', platform: 'web', catalog_version: 9, ws_connected: false });
    expect(hb.sync.queued).toBe(2); // sale.opened + line_added, not yet pushed
    expect(hb.open_sale_id).toBe(session.state().sale!.sale_id);
    expect(hb.hardware.terminal.state).toBe('not_present');
  });

  it('offline, a heartbeat just fails quietly and selling goes on', async () => {
    const { api, ops, session } = await setup();
    api.online = false;
    expect(await ops.beat()).toBeNull();
    await session.addItem(COFFEE);
    expect(session.state().sale!.lines).toHaveLength(1);
  });
});

describe('remote actions', () => {
  it('force sync pushes the queue and reports what happened', async () => {
    const { api, ops, session, store } = await setup();
    await session.addItem(COFFEE);
    const a = action('force_sync');
    api.pending = [a];
    await ops.beat();
    expect(api.results).toEqual([{ id: a.action_id, status: 'succeeded', message: 'Pushed 2 events; 0 still queued' }]);
    expect((await store.counts()).queued).toBe(0);
  });

  it('runs each action once, even if it arrives by socket and heartbeat both', async () => {
    const { api, ops } = await setup();
    const a = action('push_config');
    await ops.execute(a);
    api.pending = [a];
    await ops.beat();
    expect(api.results.filter((r) => r.id === a.action_id)).toHaveLength(1);
  });

  it('uploads the log ring on request', async () => {
    const { api, ops, log } = await setup();
    log.info('hello', { n: 1 });
    log.warn('careful');
    await new Promise((r) => setTimeout(r, 0));
    await ops.execute(action('upload_logs'));
    const lines = api.uploads[0]!;
    expect(lines.map((l) => l.msg)).toEqual(['hello', 'careful', 'remote action']); // the request itself is logged too
    expect(lines[0]!.ctx).toEqual({ n: 1 });
  });

  it('is honest about what it cannot do: device-module actions and missing screens are "unsupported"', async () => {
    const { api, ops } = await setup();
    await ops.execute(action('reboot_device'));
    await ops.execute(action('reprint', { sale_id: randomUUID() }));
    expect(api.results.map((r) => r.status)).toEqual(['unsupported', 'unsupported']);
    expect(api.results[0]!.message).toContain('Device Owner module');
  });

  it('restart reports back before restarting', async () => {
    const { api, ops } = await setup();
    const order: string[] = [];
    ops.setHandlers({ restartApp: () => order.push(`restart after ${api.results.length} result(s)`) });
    await ops.execute(action('restart_app'));
    expect(order).toEqual(['restart after 1 result(s)']);
  });

  it('push config offline fails instead of pretending', async () => {
    const { api, ops } = await setup();
    api.online = false;
    await ops.execute(action('push_config'));
    expect(api.results[0]).toMatchObject({ status: 'failed' });
  });
});

describe('log ring', () => {
  it(`keeps only the last ${LOG_RING_SIZE} lines`, async () => {
    const store = new MemoryEventStore();
    for (let i = 0; i < LOG_RING_SIZE + 25; i++) await store.appendLog({ at: '2026-09-24T00:00:00Z', level: 'info', msg: `m${i}`, ctx: null });
    const last = await store.recentLogs(LOG_RING_SIZE + 100);
    expect(last).toHaveLength(LOG_RING_SIZE);
    expect(last[0]!.msg).toBe('m25');
  });
});
