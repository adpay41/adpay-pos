/**
 * Time clock at the register (build plan P15, Bible 1.8). Clocking in is separate from signing in:
 * a manager who signs in to approve a void isn't starting a shift. Each punch is an event in the
 * local log (works offline, syncs like sales); who is on the clock on this register is kept in the
 * store's meta so it survives a restart. Hours are folded on the server (`foldShifts`).
 */
import type { SaleSession } from './session';
import type { EventStore } from './store';

const KEY = 'clocked_in';

export class TimeClock {
  /** user_id → when they clocked in on this register (ISO). */
  private on = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: EventStore,
    private readonly session: SaleSession,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async restore(): Promise<void> {
    const raw = await this.store.getMeta(KEY);
    this.on = new Map(raw ? (JSON.parse(raw) as [string, string][]) : []);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** When this person clocked in here, or null. */
  since(userId: string): string | null {
    return this.on.get(userId) ?? null;
  }

  /** Whole minutes on the clock so far. */
  minutes(userId: string): number {
    const at = this.on.get(userId);
    return at ? Math.max(0, Math.floor((this.now().getTime() - Date.parse(at)) / 60_000)) : 0;
  }

  async clockIn(userId: string): Promise<void> {
    if (this.on.has(userId)) return;
    await this.session.recordStaff('staff.clocked_in', { user_id: userId });
    this.on.set(userId, this.now().toISOString());
    await this.save();
  }

  async clockOut(userId: string, reason: 'manual' | 'handover' = 'manual'): Promise<void> {
    if (!this.on.has(userId)) return;
    await this.session.recordStaff('staff.clocked_out', { user_id: userId, reason });
    this.on.delete(userId);
    await this.save();
  }

  private async save() {
    await this.store.setMeta(KEY, JSON.stringify([...this.on]));
    for (const fn of this.listeners) fn();
  }
}
