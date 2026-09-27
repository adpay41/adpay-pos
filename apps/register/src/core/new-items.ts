/**
 * Items created at this register from an unknown barcode (build plan P5, Bible 1.1). The register
 * mints the item id, rings it immediately, and keeps the create command in a local outbox until
 * the server has it, so the whole flow works offline. Until the next catalog pull includes the
 * item, it is overlaid on the cached snapshot.
 *
 * The server applies each command idempotently. If another register created the same barcode
 * first, this item becomes an alias of that one (ADR 0013). Either way the next snapshot carries
 * the canonical item, and the overlay drops ours.
 */
import {
  barcodeKey,
  deriveCardPrice,
  effectiveMinAge,
  cents,
  type CatalogItem,
  type CatalogSnapshot,
  type DeviceBarcodeAttach,
  type DeviceBarcodeAttachResult,
  type DeviceItemCreate,
  type DeviceItemResult,
} from '@adpay/shared';
import type { EventStore } from './store';

const KEY = 'pending_items';
const ATTACH_KEY = 'pending_barcodes';

export interface ItemTransport {
  createItem(cmd: DeviceItemCreate): Promise<DeviceItemResult>;
  /** Scan-to-attach (ADR 0043). Optional so older test transports still fit. */
  attachBarcode?(cmd: DeviceBarcodeAttach): Promise<DeviceBarcodeAttachResult>;
}

export class NewItemOutbox {
  private pending: DeviceItemCreate[] = [];
  /** Barcodes put on existing items at this register (ADR 0043), sent after the new items. */
  private attaches: DeviceBarcodeAttach[] = [];
  private listeners = new Set<(p: readonly DeviceItemCreate[]) => void>();

  constructor(
    private readonly store: EventStore,
    private readonly transport: ItemTransport,
    private readonly onRejected: (cmd: DeviceItemCreate, reason: string) => void = () => undefined,
  ) {}

  async load(): Promise<void> {
    this.pending = JSON.parse((await this.store.getMeta(KEY)) ?? '[]') as DeviceItemCreate[];
    this.attaches = JSON.parse((await this.store.getMeta(ATTACH_KEY)) ?? '[]') as DeviceBarcodeAttach[];
    this.notify();
  }

  list(): readonly DeviceItemCreate[] {
    return this.pending;
  }

  /** Everything waiting for the server: new items and attached barcodes. */
  size(): number {
    return this.pending.length + this.attaches.length;
  }

  subscribe(fn: (p: readonly DeviceItemCreate[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.pending);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn(this.pending);
  }

  private async save() {
    await this.store.setMeta(KEY, this.pending.length ? JSON.stringify(this.pending) : null);
    await this.store.setMeta(ATTACH_KEY, this.attaches.length ? JSON.stringify(this.attaches) : null);
    this.notify();
  }

  async add(cmd: DeviceItemCreate): Promise<void> {
    this.pending = [...this.pending, cmd];
    await this.save();
  }

  /** The cashier said an unknown barcode is this item: it rings it from now on, here and (after sync) everywhere. */
  async attach(cmd: DeviceBarcodeAttach): Promise<void> {
    this.attaches = [...this.attaches, cmd];
    await this.save();
  }

  /**
   * Send everything pending, oldest first. A network failure stops the flush and is rethrown, so
   * the sync engine backs off. A validation refusal (4xx) drops that command and reports it, so one
   * bad item can't block the queue. Sales already rung with it stay in the log either way.
   */
  async flush(): Promise<void> {
    for (const cmd of [...this.pending]) {
      try {
        await this.transport.createItem(cmd);
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 429) {
          this.onRejected(cmd, (e as Error).message);
        } else {
          throw e;
        }
      }
      this.pending = this.pending.filter((p) => p.item_id !== cmd.item_id);
      await this.save();
    }
    // After the items, so a barcode attached to an item made here finds it on the server.
    if (!this.transport.attachBarcode) return;
    for (const cmd of [...this.attaches]) {
      try {
        await this.transport.attachBarcode(cmd);
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 429) {
          this.onRejected({ item_id: cmd.item_id, name: '(attached barcode)', category_id: null, cash_price_cents: 0, upc: cmd.barcode, created_by_user_id: cmd.attached_by_user_id, created_at: cmd.attached_at }, (e as Error).message);
        } else {
          throw e;
        }
      }
      this.attaches = this.attaches.filter((a) => a.attach_id !== cmd.attach_id);
      await this.save();
    }
  }

  /** The cached snapshot plus pending items it doesn't have yet, priced for this location. */
  overlay(snapshot: CatalogSnapshot): CatalogSnapshot {
    const known = new Set(snapshot.items.map((i) => i.item_id));
    const extra = this.pending.filter((p) => !known.has(p.item_id)).map((p) => pendingItem(snapshot, p));
    const withNew = extra.length ? { ...snapshot, items: [...snapshot.items, ...extra] } : snapshot;
    return this.attaches.length ? withAttached(withNew, this.attaches) : withNew;
  }
}

/**
 * Pending attached barcodes on the cached catalog, until a snapshot carries them: onto the UPC when
 * the item has none, else as an extra barcode. A barcode the catalog already rings is left alone.
 */
export function withAttached(snapshot: CatalogSnapshot, attaches: readonly DeviceBarcodeAttach[]): CatalogSnapshot {
  const known = new Set<string>();
  for (const i of snapshot.items) {
    if (i.upc) known.add(barcodeKey(i.upc));
    for (const b of i.barcodes ?? []) known.add(barcodeKey(b.barcode));
  }
  const byItem = new Map<string, string[]>();
  for (const a of attaches) {
    const k = barcodeKey(a.barcode);
    if (known.has(k)) continue;
    known.add(k);
    byItem.set(a.item_id, [...(byItem.get(a.item_id) ?? []), a.barcode]);
  }
  if (!byItem.size) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((i) => {
      const codes = byItem.get(i.item_id);
      if (!codes) return i;
      const upc = i.upc ?? codes[0]!;
      const extra = i.upc ? codes : codes.slice(1);
      return { ...i, upc, barcodes: [...(i.barcodes ?? []), ...extra.map((barcode) => ({ barcode, pack_qty: 1 }))] };
    }),
  };
}

export function pendingItem(snapshot: CatalogSnapshot, p: DeviceItemCreate): CatalogItem {
  const cat = snapshot.categories.find((c) => c.category_id === p.category_id) ?? null;
  const taxable = cat?.taxable ?? true;
  return {
    item_id: p.item_id,
    category_id: p.category_id,
    name: p.name,
    sku: null,
    upc: p.upc,
    plu: null,
    barcodes: [],
    cash_price_cents: p.cash_price_cents,
    card_price_cents: deriveCardPrice(cents(p.cash_price_cents), snapshot.dual_price_rate_ppm),
    card_price_override: false,
    open_price: false,
    cost_cents: null,
    taxable,
    tax_rate_ppm: taxable ? snapshot.tax_rate_ppm : 0,
    tax_class: cat?.tax_class ?? 'standard',
    min_age: effectiveMinAge(cat?.min_age ?? null, cat?.restriction ?? null, snapshot.compliance?.min_ages ?? null),
    restriction: cat?.restriction ?? null,
    color: null,
    image_url: null,
    sort: 1_000_000,
    sell_unit: 'each',
    pack_qty: 1,
    active: true,
  };
}
