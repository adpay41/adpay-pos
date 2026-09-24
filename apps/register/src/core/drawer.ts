/**
 * The register's cash drawer (build plan P6, Bible 1.2). One session at a time per register:
 * count the starting float → sell → drops, paid-outs and paid-ins as they happen → blind count at
 * close. Everything is an event in the local log, so it works offline and the server folds the
 * same numbers (shared `foldDrawer`).
 *
 * The drawer only opens on a cash tender, a recorded movement, or "no sale", and no-sale needs
 * `drawer.no_sale` (or a manager's PIN). The caller kicks the hardware; this records it.
 */
import { cents, denominationTotal, foldDrawer, type CashMovementKind, type Cents, type DrawerSession } from '@adpay/shared';
import type { SaleSession } from './session';
import type { EventStore } from './store';

const KEY = 'drawer_session';

interface OpenRef {
  session_id: string;
  /** device_seq of the opening event: the session is folded from here. */
  from_seq: number;
}

export class DrawerManager {
  private open: OpenRef | null = null;
  private listeners = new Set<(s: DrawerSession | null) => void>();
  private last: DrawerSession | null = null;

  constructor(
    private readonly store: EventStore,
    private readonly session: SaleSession,
    private readonly uuid: () => string,
  ) {}

  async restore(): Promise<void> {
    const raw = await this.store.getMeta(KEY);
    this.open = raw ? (JSON.parse(raw) as OpenRef) : null;
    await this.refresh();
  }

  subscribe(fn: (s: DrawerSession | null) => void): () => void {
    this.listeners.add(fn);
    fn(this.last);
    return () => this.listeners.delete(fn);
  }

  /** The open session with its running totals, or null when the drawer hasn't been started. */
  current(): DrawerSession | null {
    return this.last;
  }

  /** Re-fold after anything that moves cash (a sale, a refund, a movement). */
  async refresh(): Promise<DrawerSession | null> {
    if (!this.open) {
      this.last = null;
    } else {
      const { sessions } = foldDrawer(await this.store.eventsSince(this.open.from_seq));
      this.last = sessions.find((s) => s.session_id === this.open!.session_id) ?? null;
    }
    for (const fn of this.listeners) fn(this.last);
    return this.last;
  }

  async start(float: Cents): Promise<DrawerSession> {
    if (this.open) throw new Error('The drawer is already started. Close and count it first.');
    const session_id = this.uuid();
    const e = await this.session.recordDrawerEvent('drawer.session_opened', { session_id, float_cents: float });
    this.open = { session_id, from_seq: e.device_seq };
    await this.store.setMeta(KEY, JSON.stringify(this.open));
    return (await this.refresh())!;
  }

  /** Safe drop, paid-out or paid-in. The drawer opens for it (caller kicks the hardware). */
  async move(kind: CashMovementKind, amount: Cents, reason: string, payee: string | null = null): Promise<DrawerSession> {
    if (!this.open) throw new Error('Start the drawer first (count the starting cash).');
    if (amount <= 0) throw new Error('Enter an amount');
    // No "more than the drawer holds" check: it would let a cashier probe the expected amount and
    // defeat the blind count. A wrong amount shows up as over/short when the drawer is counted.
    await this.session.recordDrawerEvent('drawer.cash_movement', {
      movement_id: this.uuid(),
      session_id: this.open.session_id,
      kind,
      amount_cents: amount,
      reason: reason.trim(),
      payee: payee?.trim() || null,
    });
    await this.session.recordDrawerEvent('drawer.opened', { reason: 'movement', by_user_id: this.session.actorId() });
    return (await this.refresh())!;
  }

  /** "No sale": the drawer opened outside a sale. The caller checked `drawer.no_sale` or got an override. */
  async noSale(): Promise<void> {
    await this.session.recordDrawerEvent('drawer.opened', { reason: 'manual', by_user_id: this.session.actorId() });
    await this.refresh();
  }

  /**
   * Blind close: the count goes in before anyone sees what was expected. Returns the closed session
   * with its over/short (counted − expected, folded from the log).
   */
  /**
   * Close with the blind count. P15: optionally by denomination (must add up), with a photo of the
   * count sheet, and as a **handover**: the next session starts at once with the counted cash as its float.
   */
  async close(
    counted: Cents,
    opts: { denominations?: Record<string, number> | null; photo_media_id?: string | null; handover?: boolean } = {},
  ): Promise<DrawerSession> {
    if (!this.open) throw new Error('The drawer is not started.');
    if (opts.denominations && denominationTotal(opts.denominations) !== counted) throw new Error('The denominations don’t add up to the count');
    const { session_id, from_seq } = this.open;
    await this.session.recordDrawerEvent('drawer.opened', { reason: 'count', by_user_id: this.session.actorId() });
    await this.session.recordDrawerEvent('drawer.session_closed', {
      session_id,
      counted_cents: cents(counted),
      blind: true,
      denominations: opts.denominations ?? null,
      photo_media_id: opts.photo_media_id ?? null,
      handover: !!opts.handover,
    });
    const { sessions } = foldDrawer(await this.store.eventsSince(from_seq));
    this.open = null;
    await this.store.setMeta(KEY, null);
    await this.refresh();
    const closed = sessions.find((s) => s.session_id === session_id)!;
    // Handover: the cash just counted is the next person's float, so nothing is recounted.
    if (opts.handover) await this.start(counted);
    return closed;
  }

  /** A bill refused as counterfeit (P15): logged with who and when; the drawer doesn't open. */
  async flagCounterfeit(denominationCents: number, note: string | null): Promise<void> {
    await this.session.recordDrawerEvent('drawer.counterfeit', { session_id: this.open?.session_id ?? null, denomination_cents: denominationCents, note: note?.trim() || null });
    await this.refresh();
  }
}
