import { randomUUID } from 'node:crypto';
import {
  cents,
  foldSale,
  parseRegisterEvent,
  saleNetCents,
  sum,
  type CatalogItem,
  type CatalogSnapshot,
  type RegisterEvent,
} from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { displayFor } from '../src/core/display';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';
import { SyncEngine, type Transport } from '../src/core/sync';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };

function item(name: string, cash: number, card: number, extra: Partial<CatalogItem> = {}): CatalogItem {
  return {
    item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash,
    card_price_cents: card, card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 66_250,
    min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
    ...extra,
  };
}

const BEC = item('Bacon, Egg & Cheese', 599, 623);
const COFFEE = item('Hot Coffee — Medium', 225, 234);
const CIGS = item('Marlboro Red — Pack', 1400, 1400, { taxable: false, tax_rate_ppm: 0, min_age: 21 });

function newSession(store = new MemoryEventStore()) {
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 7, uuid: randomUUID });
  return { store, session };
}

/** A fake API that behaves like the real one: validates, dedupes by event_id, can go offline. */
class FakeServer implements Transport {
  readonly stored = new Map<string, RegisterEvent>();
  online = true;
  /** Store the batch but "lose" the response — the nastiest network failure. */
  dropNextResponse = false;
  calls = 0;

  async pushEvents(events: unknown[]) {
    this.calls++;
    if (!this.online) throw new Error('network unreachable');
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const raw of events) {
      const e = parseRegisterEvent(raw);
      if (this.stored.has(e.event_id)) duplicates.push(e.event_id);
      else {
        this.stored.set(e.event_id, e);
        accepted.push(e.event_id);
      }
    }
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new Error('connection reset');
    }
    return { accepted, duplicates, rejected: [] };
  }

  version = 7;
  pulls = 0;
  items: CatalogItem[] = [BEC, COFFEE, CIGS];

  async pullCatalog(): Promise<CatalogSnapshot> {
    if (!this.online) throw new Error('network unreachable');
    this.pulls++;
    return {
      merchant_id: tenancy.merchant_id, location_id: tenancy.location_id, catalog_version: this.version, dual_price_rate_ppm: 40_000,
      tax_rate_ppm: 66_250, generated_at: new Date().toISOString(), categories: [], items: this.items, quick_keys: [],
    };
  }

  async catalogVersion(): Promise<number> {
    if (!this.online) throw new Error('network unreachable');
    return this.version;
  }
}

describe('SaleSession', () => {
  it('builds the cart purely from appended events', async () => {
    const { store, session } = newSession();
    await session.addItem(BEC, { qty: 2 });
    const s = await session.addItem(COFFEE);
    const sale = s.sale!;
    expect(sale.lines).toHaveLength(2);
    // cash: 1198 + 225 = 1423, tax 6.625% = 94.27 -> 94, total 1517
    expect(sale.cash).toEqual({ subtotal_cents: 1423, tax_cents: 94, total_cents: 1517 });
    // card: 1246 + 234 = 1480, tax 98.05 -> 98, total 1578
    expect(sale.card.total_cents).toBe(1578);
    expect(store.snapshot().map((e) => e.type)).toEqual(['sale.opened', 'sale.line_added', 'sale.line_added']);
    expect(store.snapshot().map((e) => e.device_seq)).toEqual([0, 1, 2]);
  });

  it('removing a line is a new event, not an edit', async () => {
    const { store, session } = newSession();
    const s = await session.addItem(BEC);
    const after = await session.removeLine(s.sale!.lines[0]!.line_id);
    expect(after.sale!.lines).toHaveLength(0);
    expect(store.snapshot().map((e) => e.type)).toEqual(['sale.opened', 'sale.line_added', 'sale.line_removed']);
  });

  it('refuses age-restricted items without the check, and records the check when done', async () => {
    const { store, session } = newSession();
    await expect(session.addItem(CIGS)).rejects.toThrow(SaleError);
    const s = await session.addItem(CIGS, { ageConfirmed: true });
    expect(s.sale!.lines[0]!.age_verified).toBe(true);
    expect(store.snapshot().at(-1)!.type).toBe('sale.age_verified');
  });

  it('cash tender computes change, completes the sale and closes the ticket', async () => {
    const { store, session } = newSession();
    await session.addItem(BEC);
    const { sale, change } = await session.tenderCash(cents(1000));
    // 599 + 40 tax = 639; change from $10 = 361
    expect(sale.status).toBe('completed');
    expect(sale.cash.total_cents).toBe(639);
    expect(change).toBe(361);
    expect(sale.mismatch).toBe(false);
    expect(session.state().sale).toBeNull();
    expect(session.state().lastCompleted?.sale_id).toBe(sale.sale_id);
    expect(await store.getMeta('open_sale_id')).toBeNull();
  });

  it('refuses short cash and empty tickets', async () => {
    const { session } = newSession();
    await session.addItem(BEC);
    await expect(session.tenderCash(cents(500))).rejects.toThrow();
    const empty = newSession().session;
    await expect(empty.tenderCash(cents(500))).rejects.toThrow(SaleError);
  });

  it('survives a restart mid-ticket', async () => {
    const store = new MemoryEventStore();
    const first = newSession(store).session;
    await first.addItem(BEC);
    await first.addItem(COFFEE);
    const second = newSession(store).session;
    await second.restore();
    expect(second.state().sale!.lines.map((l) => l.name)).toEqual(['Bacon, Egg & Cheese', 'Hot Coffee — Medium']);
    const { sale } = await second.tenderCash(cents(2000));
    expect(sale.lines).toHaveLength(2);
  });

  it('serializes double taps so device_seq stays strictly increasing', async () => {
    const { store, session } = newSession();
    await Promise.all([session.addItem(BEC), session.addItem(COFFEE), session.addItem(BEC)]);
    const seqs = store.snapshot().map((e) => e.device_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(session.state().sale!.lines).toHaveLength(3);
  });

  it('shows the customer both prices before tender', async () => {
    const { session } = newSession();
    const s = await session.addItem(BEC, { qty: 2 });
    const d = displayFor('Deli', s.sale);
    expect(d.phase).toBe('cart');
    expect(d.lines[0]).toMatchObject({ cash_cents: 1198, card_cents: 1246 });
    expect(d.cash_total_cents).toBe(1277);
    expect(d.card_total_cents).toBe(1329);
  });
});

describe('offline sales and sync (spec acceptance, in miniature)', () => {
  it('50 sales offline, reconnect with a lost response: all 50 land once, totals match to the cent', async () => {
    const { store, session } = newSession();
    const server = new FakeServer();
    const sync = new SyncEngine(store, server);

    server.online = false;
    const localTotals: number[] = [];
    for (let i = 0; i < 50; i++) {
      await session.addItem(i % 3 === 0 ? BEC : COFFEE, { qty: 1 + (i % 2) });
      if (i % 5 === 0) await session.addItem(CIGS, { ageConfirmed: true });
      const total = session.state().sale!.cash.total_cents;
      const { sale } = await session.tenderCash(cents(Math.ceil(total / 2000) * 2000));
      await session.recordDrawer('cash_sale', sale.sale_id);
      await session.recordReceipt(sale.sale_id, 'original');
      localTotals.push(sale.cash.total_cents);
    }
    await expect(sync.pushOnce()).rejects.toThrow('network unreachable');
    expect((await store.counts()).queued).toBe(store.snapshot().length);

    // Back online — but the first response is lost after the server stored the batch.
    server.online = true;
    server.dropNextResponse = true;
    await expect(sync.pushOnce()).rejects.toThrow('connection reset');
    await sync.pushOnce(); // retry: everything comes back as duplicate — no double counting

    expect((await store.counts()).queued).toBe(0);
    expect(server.stored.size).toBe(store.snapshot().length);

    const saleIds = new Set([...server.stored.values()].map((e) => e.sale_id).filter((x): x is string => !!x));
    expect(saleIds.size).toBe(50);
    const serverTotals = [...saleIds].map((id) => saleNetCents(foldSale(id, [...server.stored.values()])));
    expect(sum(serverTotals.map(cents))).toBe(sum(localTotals.map(cents)));
  });

  it('boots from the cached catalog when the server is unreachable', async () => {
    const store = new MemoryEventStore();
    const server = new FakeServer();
    const sync = new SyncEngine(store, server);
    expect((await sync.pullCatalog())?.catalog_version).toBe(7);
    server.online = false;
    const offline = await new SyncEngine(store, server).pullCatalog();
    expect(offline?.items).toHaveLength(3);
  });

  it('pulls a new catalog only when the server version moves, and tells the screen', async () => {
    const store = new MemoryEventStore();
    const server = new FakeServer();
    const sync = new SyncEngine(store, server);
    const seen: number[] = [];
    sync.onCatalog((c) => seen.push(c.items[0]!.cash_price_cents));
    await sync.pullCatalog();
    expect(await sync.refreshCatalogIfStale()).toBe(false);
    expect(server.pulls).toBe(1);

    // A price change in admin bumps the version; the register picks it up on its next tick.
    server.version = 8;
    server.items = [{ ...BEC, cash_price_cents: 649, card_price_cents: 675 }, COFFEE, CIGS];
    expect(await sync.refreshCatalogIfStale()).toBe(true);
    expect(server.pulls).toBe(2);
    expect(seen).toEqual([599, 649]);
    expect((await sync.cachedCatalog())?.catalog_version).toBe(8);
  });

  it('an open ticket keeps the price it was rung at when the catalog changes underneath it', async () => {
    const { session } = newSession();
    await session.addItem(BEC); // rung at 599
    const repriced = { ...BEC, cash_price_cents: 649, card_price_cents: 675 };
    const s = await session.addItem(repriced);
    expect(s.sale!.lines.map((l) => l.unit_cash_price_cents)).toEqual([599, 649]);
  });

  it('a rejected event is acked as rejected and does not block the queue', async () => {
    const { store, session } = newSession();
    await session.addItem(BEC);
    const bad = store.snapshot()[0]!.event_id;
    const transport: Transport = {
      pushEvents: async (events) => ({
        accepted: (events as RegisterEvent[]).map((e) => e.event_id).filter((id) => id !== bad),
        duplicates: [],
        rejected: [{ event_id: bad, reason: 'test' }],
      }),
      pullCatalog: async () => { throw new Error('unused'); },
      catalogVersion: async () => { throw new Error('unused'); },
    };
    await new SyncEngine(store, transport).pushOnce();
    expect(await store.counts()).toMatchObject({ queued: 0, rejected: 1 });
  });
});
