/**
 * The register's sale engine. Every cashier action appends an immutable event to the local store;
 * the cart on screen is `foldSale` of those events — the same fold the server and reports use. There
 * is no separate mutable cart that could drift from what gets synced (ADR 0002, ADR 0004).
 *
 * Works with no network and no server: nothing here awaits anything but the local store.
 * Actions are serialized so device_seq stays strictly increasing even if the UI double-taps.
 */
import {
  changeDue,
  foldSale,
  parseRegisterEvent,
  type CatalogItem,
  type Cents,
  type EventPayload,
  type EventType,
  type FoldedSale,
  type RegisterEvent,
  type TenantIds,
} from '@adpay/shared';
import type { EventStore } from './store';

export interface SessionDeps {
  store: EventStore;
  tenancy: TenantIds;
  catalogVersion: () => number;
  uuid: () => string;
  now?: () => Date;
}

export class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleError';
  }
}

const OPEN_SALE_KEY = 'open_sale_id';
const LAST_SALE_KEY = 'last_completed_sale_id';

export interface SessionState {
  sale: FoldedSale | null;
  lastCompleted: FoldedSale | null;
}

/** Events that record who is at the register rather than what was sold. */
export type StaffEventType = 'staff.signed_in' | 'staff.signed_out' | 'staff.pin_failed' | 'override.granted';

export class SaleSession {
  /** Signed-in person; stamped on every event as `actor_user_id` (P3). */
  private actor: string | null = null;
  private saleId: string | null = null;
  private events: RegisterEvent[] = [];
  private lastCompleted: FoldedSale | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: SessionState) => void>();
  private readonly now: () => Date;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Reload an open ticket after an app restart or power cut. */
  async restore(): Promise<void> {
    const open = await this.deps.store.getMeta(OPEN_SALE_KEY);
    if (open) {
      this.saleId = open;
      this.events = await this.deps.store.eventsForSale(open);
      const folded = foldSale(open, this.events);
      if (folded.status === 'completed' || folded.status === 'voided') await this.clearOpen();
    }
    const last = await this.deps.store.getMeta(LAST_SALE_KEY);
    if (last) this.lastCompleted = foldSale(last, await this.deps.store.eventsForSale(last));
    this.notify();
  }

  /** Who is signed in. Set by the StaffGate; null only when the merchant has no PINs set up. */
  setActor(userId: string | null): void {
    this.actor = userId;
  }

  actorId(): string | null {
    return this.actor;
  }

  /** Record a sign-in, sign-out, PIN failure or manager override (saleless unless tied to a ticket). */
  recordStaff<T extends StaffEventType>(type: T, payload: EventPayload<T>, saleId: string | null = null): Promise<void> {
    return this.serial(async () => {
      await this.emit(type, payload, saleId);
    });
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  state(): SessionState {
    return { sale: this.saleId ? foldSale(this.saleId, this.events) : null, lastCompleted: this.lastCompleted };
  }

  private notify() {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async emit<T extends EventType>(type: T, payload: EventPayload<T>, saleId: string | null): Promise<RegisterEvent> {
    const t = this.deps.tenancy;
    const event = parseRegisterEvent({
      event_id: this.deps.uuid(),
      schema_version: 1,
      sale_id: saleId,
      device_seq: await this.deps.store.nextSeq(),
      occurred_at: this.now().toISOString(),
      org_id: t.org_id,
      merchant_id: t.merchant_id,
      location_id: t.location_id,
      register_id: t.register_id,
      trace_id: saleId ? saleId.replace(/-/g, '') : this.deps.uuid().replace(/-/g, ''),
      actor_user_id: this.actor,
      type,
      payload,
    });
    await this.deps.store.append(event);
    if (saleId && saleId === this.saleId) this.events.push(event);
    return event;
  }

  private async ensureOpen(): Promise<string> {
    if (this.saleId) return this.saleId;
    const id = this.deps.uuid();
    this.saleId = id;
    this.events = [];
    await this.deps.store.setMeta(OPEN_SALE_KEY, id);
    await this.emit('sale.opened', { cashier_user_id: this.actor, catalog_version: this.deps.catalogVersion() }, id);
    return id;
  }

  private async clearOpen() {
    this.saleId = null;
    this.events = [];
    await this.deps.store.setMeta(OPEN_SALE_KEY, null);
  }

  private current(): FoldedSale {
    if (!this.saleId) throw new SaleError('No open sale');
    return foldSale(this.saleId, this.events);
  }

  /**
   * Add a catalog item. Age-restricted items require the cashier's confirmation, recorded as its
   * own event (manual check in v1; ID scan later).
   *
   * Quantity intelligence (Bible 1.1): ringing the same item again right after itself raises that
   * line's quantity instead of adding a line ("tap twice = qty 2", scanning a second can). A case
   * barcode arrives with `qty` = its pack quantity. An open-price item carries the typed `price`.
   */
  addItem(
    item: CatalogItem,
    opts: {
      qty?: number;
      ageConfirmed?: boolean;
      entry?: 'key' | 'scan' | 'search' | 'new_item';
      /** Typed at the register for an open-price item: both prices, card derived by the caller. */
      price?: { cash: Cents; card: Cents };
    } = {},
  ): Promise<SessionState> {
    return this.serial(async () => {
      if (!item.active) throw new SaleError(`${item.name} is not for sale`);
      const qty = opts.qty ?? 1;
      const last = this.saleId ? this.lastLine() : null;
      const merge = !opts.price && !item.open_price && last && last.item_id === item.item_id && last.unit_cash_price_cents === item.cash_price_cents;
      if (merge) {
        // Same customer, same line: an age check already done for it covers this unit too.
        await this.emit('sale.line_qty_changed', { line_id: last.line_id, qty: Math.min(10_000, last.qty + qty) }, this.saleId!);
        this.notify();
        return this.state();
      }
      if (item.min_age && !opts.ageConfirmed) throw new SaleError(`${item.name} needs an age check (${item.min_age}+)`);
      if (item.open_price && !opts.price) throw new SaleError(`Enter a price for ${item.name}`);
      const saleId = await this.ensureOpen();
      const line_id = this.deps.uuid();
      await this.emit(
        'sale.line_added',
        {
          line_id,
          item_id: item.item_id,
          name: item.name,
          category_id: item.category_id,
          qty,
          unit_cash_price_cents: opts.price?.cash ?? item.cash_price_cents,
          unit_card_price_cents: opts.price?.card ?? item.card_price_cents,
          taxable: item.taxable,
          tax_rate_ppm: item.tax_rate_ppm,
          min_age: item.min_age,
          sell_unit: item.sell_unit,
          pack_qty: item.pack_qty,
          price_source: opts.price ? 'open' : 'catalog',
          entry: opts.entry ?? 'key',
        },
        saleId,
      );
      if (item.min_age) await this.emit('sale.age_verified', { line_id, method: 'manual', verified_by_user_id: this.actor }, saleId);
      this.notify();
      return this.state();
    });
  }

  /** Would ringing `item` now just raise the last line's quantity? (The UI skips the age prompt then.) */
  wouldMerge(item: CatalogItem): boolean {
    if (!this.saleId || item.open_price) return false;
    const last = this.lastLine();
    return !!last && last.item_id === item.item_id && last.unit_cash_price_cents === item.cash_price_cents;
  }

  /** The most recently added line still on the ticket. */
  private lastLine(): FoldedSale['lines'][number] | null {
    const sale = foldSale(this.saleId!, this.events);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === 'sale.line_added') return sale.lines.find((l) => l.line_id === e.payload.line_id) ?? null;
    }
    return null;
  }

  /** Long-press → type a quantity (Bible 1.1). Zero is "remove the line". */
  setQty(lineId: string, qty: number): Promise<SessionState> {
    return this.serial(async () => {
      const sale = this.current();
      const line = sale.lines.find((l) => l.line_id === lineId);
      if (!line) throw new SaleError('No such line');
      if (!Number.isInteger(qty) || qty < 0 || qty > 10_000) throw new SaleError('Quantity must be 0 to 10,000');
      if (qty === 0) await this.emit('sale.line_removed', { line_id: lineId }, sale.sale_id);
      else if (qty !== line.qty) await this.emit('sale.line_qty_changed', { line_id: lineId, qty }, sale.sale_id);
      this.notify();
      return this.state();
    });
  }

  removeLine(lineId: string): Promise<SessionState> {
    return this.serial(async () => {
      const sale = this.current();
      if (!sale.lines.some((l) => l.line_id === lineId)) throw new SaleError('No such line');
      await this.emit('sale.line_removed', { line_id: lineId }, sale.sale_id);
      this.notify();
      return this.state();
    });
  }

  /**
   * Void the open ticket before tender. The caller checks `ticket.void` (or gets a manager override
   * first); the event records who was signed in. Voiding a completed sale is P7.
   */
  voidSale(reason: string): Promise<SessionState> {
    return this.serial(async () => {
      const sale = this.current();
      await this.emit('sale.voided', { reason, by_user_id: this.actor }, sale.sale_id);
      await this.clearOpen();
      this.notify();
      return this.state();
    });
  }

  /**
   * Cash tender at the cash price. Records tender + completion in one step, so a crash can never
   * leave a paid sale uncompleted: both events are appended before this resolves.
   */
  tenderCash(tendered: Cents): Promise<{ sale: FoldedSale; change: Cents }> {
    return this.serial(async () => {
      const sale = this.current();
      if (sale.lines.length === 0) throw new SaleError('Nothing to charge');
      const totals = sale.cash;
      const change = changeDue(totals.total_cents, tendered);
      await this.emit(
        'sale.tender_added',
        {
          tender_id: this.deps.uuid(),
          tender_type: 'cash',
          amount_cents: totals.total_cents,
          tendered_cents: tendered,
          change_cents: change,
          card: null,
        },
        sale.sale_id,
      );
      await this.emit('sale.completed', { price_mode: 'cash', ...totals }, sale.sale_id);
      const done = this.current();
      this.lastCompleted = done;
      await this.deps.store.setMeta(LAST_SALE_KEY, done.sale_id);
      await this.clearOpen();
      this.notify();
      return { sale: done, change };
    });
  }

  /** Record what happened at the printer and drawer, after the fact, as events. */
  recordReceipt(saleId: string, copy: 'original' | 'reprint' | 'none'): Promise<void> {
    return this.serial(async () => {
      await this.emit('receipt.printed', { copy }, saleId);
    });
  }

  recordDrawer(reason: 'cash_sale' | 'manual', saleId: string | null): Promise<void> {
    return this.serial(async () => {
      await this.emit('drawer.opened', { reason, by_user_id: this.actor }, saleId);
    });
  }

  /** Events of the last completed sale — for "reprint last". */
  async lastSaleEvents(): Promise<RegisterEvent[]> {
    const id = this.lastCompleted?.sale_id;
    return id ? this.deps.store.eventsForSale(id) : [];
  }
}
