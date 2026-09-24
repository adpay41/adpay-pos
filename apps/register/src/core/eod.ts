/**
 * End of day on the register (build plan P16, spec v1 "End of day: cash count, Z-report, print +
 * push to server"). ADR 0025.
 *
 * The Z covers every event on this register since the previous Z. It needs the drawer counted
 * first (the cash count is part of the Z). Taking it appends `eod.closed` with the range and the
 * printed totals; the server re-folds that range with the same `buildZReport` and flags any
 * difference. Works offline: the event syncs like a sale.
 */
import { buildZReport, localDate, zTotals, type CatalogSnapshot, type ZReport } from '@adpay/shared';
import type { DrawerManager } from './drawer';
import type { SaleSession } from './session';
import type { EventStore } from './store';

const KEY = 'eod';

interface EodState {
  /** The next Z's number. */
  z_number: number;
  /** First device_seq the next Z covers (inclusive). */
  from_seq: number;
  last_closed_at: string | null;
}

export class EndOfDay {
  private state: EodState = { z_number: 1, from_seq: 0, last_closed_at: null };

  constructor(
    private readonly store: EventStore,
    private readonly session: SaleSession,
    private readonly drawer: DrawerManager,
    private readonly registerId: string,
    private readonly timezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async restore(): Promise<void> {
    const raw = await this.store.getMeta(KEY);
    if (raw) this.state = JSON.parse(raw) as EodState;
  }

  lastClosedAt(): string | null {
    return this.state.last_closed_at;
  }

  /** The Z as it stands now (an X-report: nothing is closed). */
  async preview(catalog: Pick<CatalogSnapshot, 'categories'>): Promise<ZReport> {
    const events = await this.store.eventsSince(this.state.from_seq);
    const names = new Map(catalog.categories.map((c) => [c.category_id, c.name]));
    return buildZReport(events, {
      z_number: this.state.z_number,
      register_id: this.registerId,
      business_date: localDate(this.now(), this.timezone),
      from_seq: this.state.from_seq,
      categoryName: (id) => (id ? (names.get(id) ?? 'Other') : 'No category'),
    });
  }

  /** Take the Z: the drawer must be counted, and nobody may have a ticket open. */
  async close(catalog: Pick<CatalogSnapshot, 'categories'>): Promise<ZReport> {
    if (this.drawer.current()) throw new Error('Close and count the drawer first. The count is part of the Z.');
    if (this.session.state().sale?.lines.length) throw new Error('Finish or void the open ticket first.');
    const z = await this.preview(catalog);
    const e = await this.session.recordDrawerEvent('eod.closed', {
      z_number: z.z_number,
      business_date: z.business_date,
      from_seq: z.from_seq,
      to_seq: z.to_seq,
      totals: zTotals(z),
    });
    this.state = { z_number: z.z_number + 1, from_seq: e.device_seq + 1, last_closed_at: e.occurred_at };
    await this.store.setMeta(KEY, JSON.stringify(this.state));
    return z;
  }
}
