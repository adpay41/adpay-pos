/**
 * The register's sale engine. Every cashier action appends an immutable event to the local store;
 * the cart on screen is `foldSale` of those events — the same fold the server and reports use. There
 * is no separate mutable cart that could drift from what gets synced (ADR 0002, ADR 0004).
 *
 * Works with no network and no server: nothing here awaits anything but the local store.
 * Actions are serialized so device_seq stays strictly increasing even if the UI double-taps.
 */
import {
  ZERO,
  cardAmountFor,
  lineCompliance,
  localDate,
  type ComplianceSnapshot,
  cents,
  changeDue,
  coverForCard,
  splitTotals,
  type CompletionMode,
  foldSale,
  refundQuote,
  refundableQty,
  type RefundLine,
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
  /** The location's tax schedule and charges (P10); absent in tests and older snapshots. */
  compliance?: () => { snapshot: ComplianceSnapshot | undefined; locationRatePpm: number; timezone: string };
}

export class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleError';
  }
}

const OPEN_SALE_KEY = 'open_sale_id';
const LAST_SALE_KEY = 'last_completed_sale_id';
const PARKED_KEY = 'parked_sales';

/** A ticket put on hold: "customer forgot wallet; park it, serve the next, recall by tap" (Bible 1.1). */
export interface ParkedTicket {
  sale_id: string;
  held_at: string;
  label: string | null;
}

export interface SessionState {
  sale: FoldedSale | null;
  lastCompleted: FoldedSale | null;
  parked: ParkedTicket[];
}

/** Events that record who is at the register rather than what was sold. */
export type StaffEventType = 'staff.signed_in' | 'staff.signed_out' | 'staff.pin_failed' | 'override.granted' | 'staff.clocked_in' | 'staff.clocked_out';
/** Puts money back on a card through the processor (the API's card-refund endpoint). Never card data. */
export type CardRefunder = (req: { sale_id: string; refund_id: string; provider_ref: string; amount_cents: number }) => Promise<{
  status: 'approved' | 'declined' | 'error';
  provider: string;
  provider_ref: string | null;
  approval_code: string | null;
  message: string | null;
}>;

/** Cash drawer events outside a sale (P6). */
export type DrawerEventType = 'drawer.session_opened' | 'drawer.cash_movement' | 'drawer.session_closed' | 'drawer.opened' | 'drawer.counterfeit' | 'eod.closed';

export class SaleSession {
  /** Signed-in person; stamped on every event as `actor_user_id` (P3). */
  private actor: string | null = null;
  private saleId: string | null = null;
  private events: RegisterEvent[] = [];
  private lastCompleted: FoldedSale | null = null;
  private parked: ParkedTicket[] = [];
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
    this.parked = JSON.parse((await this.deps.store.getMeta(PARKED_KEY)) ?? '[]') as ParkedTicket[];
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

  /** Record a drawer session, cash movement or no-sale open. Returns the stored event. */
  recordDrawerEvent<T extends DrawerEventType>(type: T, payload: EventPayload<T>): Promise<RegisterEvent> {
    return this.serial(() => this.emit(type, payload, null));
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
    return { sale: this.saleId ? foldSale(this.saleId, this.events) : null, lastCompleted: this.lastCompleted, parked: this.parked };
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
      /** The ID barcode was scanned and passed (P16b): age and jurisdiction only, never the ID itself. */
      idCheck?: { age: number; jurisdiction: string | null };
      entry?: 'key' | 'scan' | 'search' | 'new_item';
      /** Typed at the register for an open-price item: both prices, card derived by the caller. */
      price?: { cash: Cents; card: Cents };
      /** A fee rung as its own line (bag fee, P10). */
      fee?: boolean;
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
      const unit = { cash: opts.price?.cash ?? item.cash_price_cents, card: opts.price?.card ?? item.card_price_cents };
      // Rate and per-unit charges as of today at this store, captured in the event (ADR 0018).
      const ctx = this.deps.compliance?.();
      const comp = ctx
        ? lineCompliance(item, ctx.snapshot, ctx.locationRatePpm, localDate(this.now(), ctx.timezone), unit)
        : { tax_rate_ppm: item.tax_rate_ppm, tax_class: item.tax_class ?? null, charges: [] };
      await this.emit(
        'sale.line_added',
        {
          line_id,
          item_id: item.item_id,
          name: item.name,
          category_id: item.category_id,
          qty,
          unit_cash_price_cents: unit.cash,
          unit_card_price_cents: unit.card,
          taxable: item.taxable,
          tax_rate_ppm: comp.tax_rate_ppm,
          min_age: item.min_age,
          tax_class: comp.tax_class,
          restriction: item.restriction ?? null,
          charges: comp.charges,
          sell_unit: item.sell_unit,
          pack_qty: item.pack_qty,
          price_source: opts.fee ? 'fee' : opts.price ? 'open' : 'catalog',
          entry: opts.entry ?? 'key',
        },
        saleId,
      );
      if (item.min_age)
        await this.emit(
          'sale.age_verified',
          { line_id, method: opts.idCheck ? 'id_scan' : 'manual', verified_by_user_id: this.actor, id_check: opts.idCheck ?? null },
          saleId,
        );
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

  /** The completion event for a fully paid sale: cash, card, or split (ADR 0017). */
  private async complete(saleId: string): Promise<FoldedSale> {
    const sale = this.current();
    const approved = sale.tenders.filter((t) => t.approved);
    const types = new Set(approved.map((t) => t.tender_type));
    const mode: CompletionMode = types.size > 1 ? 'split' : types.has('card') ? 'card' : 'cash';
    const totals =
      mode === 'cash'
        ? sale.cash
        : mode === 'card'
          ? sale.card
          : splitTotals(sale.cash, sale.card, approved.map((t) => ({ tender_type: t.tender_type, amount_cents: t.amount_cents, covers_cash_cents: t.covers_cash_cents })));
    await this.emit('sale.completed', { price_mode: mode, ...totals }, saleId);
    const done = this.current();
    this.lastCompleted = done;
    await this.deps.store.setMeta(LAST_SALE_KEY, done.sale_id);
    await this.clearOpen();
    this.notify();
    return done;
  }

  /**
   * Cash tender at the cash price. With `partial`, cash less than what's left pays part of the sale
   * and the rest goes on a card (split tender). Otherwise the tender and the completion are recorded
   * in one step, so a crash can never leave a paid sale uncompleted.
   */
  tenderCash(tendered: Cents, opts: { partial?: boolean } = {}): Promise<{ sale: FoldedSale; change: Cents; completed: boolean }> {
    return this.serial(async () => {
      const sale = this.current();
      if (sale.lines.length === 0) throw new SaleError('Nothing to charge');
      const left = sale.remaining_cash_cents;
      if (left <= 0) throw new SaleError('This ticket is already paid');
      if (tendered < left && !opts.partial) throw new SaleError('Not enough cash');
      const applied = tendered < left ? tendered : left;
      const change = tendered < left ? cents(0) : changeDue(left, tendered);
      await this.emit(
        'sale.tender_added',
        { tender_id: this.deps.uuid(), tender_type: 'cash', amount_cents: applied, tendered_cents: tendered, change_cents: change, card: null, covers_cash_cents: applied },
        sale.sale_id,
      );
      if (applied < left) {
        this.notify();
        return { sale: this.current(), change, completed: false };
      }
      return { sale: await this.complete(sale.sale_id), change, completed: true };
    });
  }

  /**
   * Card, step 1: the amount goes to the terminal. Records the request (ticket replay shows it) and
   * returns the tender id, which is the idempotency key: retrying with it can never charge twice.
   * `amount` defaults to the card price of everything left.
   */
  startCard(amount?: Cents): Promise<{ tender_id: string; amount: Cents }> {
    return this.serial(async () => {
      const sale = this.current();
      if (sale.lines.length === 0) throw new SaleError('Nothing to charge');
      const due = cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents);
      const charge = amount ?? due;
      if (charge <= 0) throw new SaleError('This ticket is already paid');
      if (charge > due) throw new SaleError('That’s more than is due');
      const tender_id = this.deps.uuid();
      await this.emit('sale.card_attempt', { tender_id, amount_cents: charge, status: 'requested', provider: 'terminal', provider_ref: null, message: null }, sale.sale_id);
      return { tender_id, amount: charge };
    });
  }

  /**
   * Card, step 2: the terminal answered. Records the outcome; an approval becomes a tender covering
   * its share at the card price, and completes the sale when nothing is left (with the tender, in
   * one step). A decline, error or timeout leaves the ticket open for another card or cash.
   */
  finishCard(
    tender_id: string,
    amount: Cents,
    result: { status: 'approved' | 'declined' | 'error' | 'timeout'; provider: string; provider_ref: string | null; approval_code: string | null; brand: string | null; last4: string | null; message: string | null },
  ): Promise<{ sale: FoldedSale; completed: boolean }> {
    return this.serial(async () => {
      const sale = this.current();
      await this.emit(
        'sale.card_attempt',
        { tender_id, amount_cents: amount, status: result.status, provider: result.provider, provider_ref: result.provider_ref, message: result.message },
        sale.sale_id,
      );
      if (result.status !== 'approved' || !result.provider_ref) {
        this.notify();
        return { sale: this.current(), completed: false };
      }
      const covers = coverForCard(amount, sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents);
      await this.emit(
        'sale.tender_added',
        {
          tender_id,
          tender_type: 'card',
          amount_cents: amount,
          tendered_cents: null,
          change_cents: null,
          card: { provider: result.provider, provider_ref: result.provider_ref, status: 'approved', approval_code: result.approval_code, brand: result.brand, last4: result.last4 },
          covers_cash_cents: covers,
        },
        sale.sale_id,
      );
      if (covers < sale.remaining_cash_cents) {
        this.notify();
        return { sale: this.current(), completed: false };
      }
      return { sale: await this.complete(sale.sale_id), completed: true };
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

  // ─────────────────────────────────────────────────────────── hold / recall (P7) ──

  private async saveParked() {
    await this.deps.store.setMeta(PARKED_KEY, this.parked.length ? JSON.stringify(this.parked) : null);
  }

  /** Park the open ticket (`sale.suspended`) so the next customer can be served. */
  hold(label: string | null = null): Promise<SessionState> {
    return this.serial(async () => {
      const sale = this.current();
      if (sale.lines.length === 0) throw new SaleError('Nothing to hold');
      await this.emit('sale.suspended', {}, sale.sale_id);
      this.parked = [...this.parked, { sale_id: sale.sale_id, held_at: this.now().toISOString(), label: label?.trim() || null }];
      await this.saveParked();
      await this.clearOpen();
      this.notify();
      return this.state();
    });
  }

  /** Bring a held ticket back (`sale.resumed`). Whatever was open is held first, never lost. */
  recall(saleId: string): Promise<SessionState> {
    return this.serial(async () => {
      if (!this.parked.some((p) => p.sale_id === saleId)) throw new SaleError('That ticket is not on hold');
      if (this.saleId) {
        const open = this.current();
        if (open.lines.length > 0) {
          await this.emit('sale.suspended', {}, open.sale_id);
          this.parked = [...this.parked, { sale_id: open.sale_id, held_at: this.now().toISOString(), label: null }];
        }
      }
      this.parked = this.parked.filter((p) => p.sale_id !== saleId);
      await this.saveParked();
      this.saleId = saleId;
      this.events = await this.deps.store.eventsForSale(saleId);
      await this.deps.store.setMeta(OPEN_SALE_KEY, saleId);
      await this.emit('sale.resumed', {}, saleId);
      this.notify();
      return this.state();
    });
  }

  /** Held tickets with their current contents, oldest first. */
  async parkedTickets(): Promise<(ParkedTicket & { sale: FoldedSale })[]> {
    const out: (ParkedTicket & { sale: FoldedSale })[] = [];
    for (const p of this.parked) out.push({ ...p, sale: foldSale(p.sale_id, await this.deps.store.eventsForSale(p.sale_id)) });
    return out;
  }

  // ─────────────────────────────────────────────────────────── refunds and voids (P7) ──

  /** A sale rung on this register, folded from the local log. */
  async saleById(saleId: string): Promise<FoldedSale | null> {
    const events = await this.deps.store.eventsForSale(saleId);
    return events.length ? foldSale(saleId, events) : null;
  }

  /**
   * Refund lines of a completed sale at the price the customer paid (cash price for a cash sale,
   * card price for a card sale). Cash goes back from the drawer; card money goes back to the card
   * through `cardRefund` (the processor), and only an approved card refund is recorded. The caller
   * checked `sale.refund` (or got an override).
   */
  refund(saleId: string, lines: RefundLine[], reason: string, cardRefund?: CardRefunder): Promise<{ sale: FoldedSale; amount: Cents; tender: 'cash' | 'card' }> {
    return this.serial(async () => {
      const sale = await this.saleById(saleId);
      if (!sale) throw new SaleError('That sale is not on this register');
      const quote = refundQuote(sale, lines);
      if (quote.lines.length === 0 || quote.amount_cents <= 0) throw new SaleError('Pick what is coming back');
      const tender = sale.tenders.find((t) => t.approved);
      const refund_id = this.deps.uuid();
      if (tender?.tender_type === 'card') {
        const card = await this.refundToCard(sale, tender, quote.amount_cents, refund_id, cardRefund);
        await this.emit('sale.refunded', { refund_id, tender_type: 'card', amount_cents: quote.amount_cents, reason, by_user_id: this.actor, card, lines: quote.lines }, saleId);
        return { sale: (await this.saleById(saleId))!, amount: quote.amount_cents, tender: 'card' as const };
      }
      await this.emit('sale.refunded', { refund_id, tender_type: 'cash', amount_cents: quote.amount_cents, reason, by_user_id: this.actor, card: null, lines: quote.lines }, saleId);
      await this.emit('drawer.opened', { reason: 'refund', by_user_id: this.actor }, saleId);
      return { sale: (await this.saleById(saleId))!, amount: quote.amount_cents, tender: 'cash' as const };
    });
  }

  /** Ask the processor to put money back on the card of `tender`. Throws unless it's approved. */
  private async refundToCard(sale: FoldedSale, tender: FoldedSale['tenders'][number], amount: Cents, refund_id: string, cardRefund?: CardRefunder) {
    if (!cardRefund || !tender.card) throw new SaleError('Card refunds need the connection to the card processor. Try again when online.');
    const r = await cardRefund({ sale_id: sale.sale_id, refund_id, provider_ref: tender.card.provider_ref, amount_cents: amount });
    if (r.status !== 'approved') throw new SaleError(r.message ?? 'The card refund did not go through. Nothing was refunded.');
    return { provider: r.provider, provider_ref: r.provider_ref ?? tender.card.provider_ref, status: 'approved' as const, approval_code: r.approval_code, brand: tender.card.brand, last4: tender.card.last4 };
  }

  /**
   * Void a completed sale: every part still paid goes back the way it came (cash from the drawer,
   * card to the card), then the sale is marked voided. The caller checked `sale.void`.
   */
  voidCompleted(saleId: string, reason: string, cardRefund?: CardRefunder): Promise<{ sale: FoldedSale; amount: Cents }> {
    return this.serial(async () => {
      const sale = await this.saleById(saleId);
      if (!sale) throw new SaleError('That sale is not on this register');
      if (sale.status !== 'completed') throw new SaleError(sale.status === 'voided' ? 'That sale is already voided' : 'Only a completed sale can be voided here');
      const left = Object.entries(refundableQty(sale)).filter(([, q]) => q > 0).map(([line_id, qty]) => ({ line_id, qty }));
      let total: Cents = ZERO;
      if (sale.price_mode === 'split') {
        // Each portion back to its own tender. Split sales can't be partly refunded, so each is whole.
        let cashBack: Cents = ZERO;
        for (const t of sale.tenders.filter((x) => x.approved)) {
          const refund_id = this.deps.uuid();
          if (t.tender_type === 'card') {
            const card = await this.refundToCard(sale, t, t.amount_cents, refund_id, cardRefund);
            await this.emit('sale.refunded', { refund_id, tender_type: 'card', amount_cents: t.amount_cents, reason: `Void: ${reason}`, by_user_id: this.actor, card, lines: [] }, saleId);
          } else {
            await this.emit('sale.refunded', { refund_id, tender_type: 'cash', amount_cents: t.amount_cents, reason: `Void: ${reason}`, by_user_id: this.actor, card: null, lines: [] }, saleId);
            cashBack = cents(cashBack + t.amount_cents);
          }
          total = cents(total + t.amount_cents);
        }
        if (cashBack > 0) await this.emit('drawer.opened', { reason: 'refund', by_user_id: this.actor }, saleId);
      } else if (left.length > 0) {
        const amount = refundQuote(sale, left).amount_cents;
        const refund_id = this.deps.uuid();
        const tender = sale.tenders.find((t) => t.approved);
        if (tender?.tender_type === 'card') {
          const card = await this.refundToCard(sale, tender, amount, refund_id, cardRefund);
          await this.emit('sale.refunded', { refund_id, tender_type: 'card', amount_cents: amount, reason: `Void: ${reason}`, by_user_id: this.actor, card, lines: left }, saleId);
        } else {
          await this.emit('sale.refunded', { refund_id, tender_type: 'cash', amount_cents: amount, reason: `Void: ${reason}`, by_user_id: this.actor, card: null, lines: left }, saleId);
          await this.emit('drawer.opened', { reason: 'refund', by_user_id: this.actor }, saleId);
        }
        total = amount;
      }
      await this.emit('sale.voided', { reason, by_user_id: this.actor }, saleId);
      return { sale: (await this.saleById(saleId))!, amount: total };
    });
  }

  /** Events of the last completed sale — for "reprint last". */
  async lastSaleEvents(): Promise<RegisterEvent[]> {
    const id = this.lastCompleted?.sale_id;
    return id ? this.deps.store.eventsForSale(id) : [];
  }
}
