/**
 * Device ↔ server sync (ADR 0002).
 *
 *  push: unacknowledged events, oldest first, in batches of up to 500 to POST /device/events. The
 *        server is idempotent on event_id, so any batch can be resent any number of times — a
 *        timeout halfway through is harmless. Accepted and duplicate ids are acked; rejected ids are
 *        acked as rejected (so one bad event can't block the queue) and counted for the ops view.
 *  pull: the versioned catalog snapshot. Server wins on catalog; the last good snapshot is cached,
 *        so the register boots and sells with no network.
 *
 * Backoff: 5s when idle-but-queued, doubling to 60s on failure. Never throws into the UI.
 */
import type { CatalogSnapshot } from '@adpay/shared';
import type { EventStore } from './store';

export const BATCH_SIZE = 500;
const CATALOG_KEY = 'catalog_snapshot';
const LAST_SYNC_KEY = 'last_sync_at';

export interface Transport {
  pushEvents(events: unknown[]): Promise<{ accepted: string[]; duplicates: string[]; rejected: { event_id: string | null; reason: string }[] }>;
  pullCatalog(): Promise<CatalogSnapshot>;
}

export interface SyncStatus {
  online: boolean;
  queued: number;
  rejected: number;
  lastSyncAt: string | null;
  lastError: string | null;
  catalogVersion: number | null;
}

export class SyncEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = 5_000;
  private running = false;
  private status: SyncStatus = { online: false, queued: 0, rejected: 0, lastSyncAt: null, lastError: null, catalogVersion: null };
  private listeners = new Set<(s: SyncStatus) => void>();

  constructor(
    private readonly store: EventStore,
    private readonly transport: Transport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private async publish(patch: Partial<SyncStatus>) {
    const counts = await this.store.counts();
    this.status = { ...this.status, ...patch, queued: counts.queued, rejected: counts.rejected };
    for (const fn of this.listeners) fn(this.status);
  }

  /** Cached snapshot, if any — used to boot offline. */
  async cachedCatalog(): Promise<CatalogSnapshot | null> {
    const raw = await this.store.getMeta(CATALOG_KEY);
    return raw ? (JSON.parse(raw) as CatalogSnapshot) : null;
  }

  async pullCatalog(): Promise<CatalogSnapshot | null> {
    try {
      const snap = await this.transport.pullCatalog();
      await this.store.setMeta(CATALOG_KEY, JSON.stringify(snap));
      await this.publish({ online: true, catalogVersion: snap.catalog_version });
      return snap;
    } catch (e) {
      await this.publish({ online: false, lastError: (e as Error).message });
      return this.cachedCatalog();
    }
  }

  /** Push everything queued. Returns how many events the server now holds from this call. */
  async pushOnce(): Promise<number> {
    let sent = 0;
    for (;;) {
      const batch = await this.store.unacked(BATCH_SIZE);
      if (batch.length === 0) break;
      const r = await this.transport.pushEvents(batch);
      await this.store.ack(r.accepted, 'accepted');
      await this.store.ack(r.duplicates, 'duplicate');
      const rejectedIds = r.rejected.map((x) => x.event_id).filter((x): x is string => x !== null);
      for (const rej of r.rejected) if (rej.event_id) await this.store.ack([rej.event_id], 'rejected', rej.reason);
      const progressed = r.accepted.length + r.duplicates.length + rejectedIds.length;
      sent += r.accepted.length + r.duplicates.length;
      if (progressed === 0) throw new Error('server acknowledged nothing in a non-empty batch');
      if (batch.length < BATCH_SIZE) break;
    }
    const at = this.now().toISOString();
    await this.store.setMeta(LAST_SYNC_KEY, at);
    await this.publish({ online: true, lastSyncAt: at, lastError: null });
    return sent;
  }

  /** Sync now (after a sale), then keep going on the backoff schedule. */
  kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  async start(): Promise<void> {
    this.status.lastSyncAt = await this.store.getMeta(LAST_SYNC_KEY);
    await this.publish({});
    this.kick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pushOnce();
      this.delay = this.status.queued > 0 ? 5_000 : 30_000;
    } catch (e) {
      this.delay = Math.min(60_000, this.delay * 2);
      await this.publish({ online: false, lastError: (e as Error).message });
    } finally {
      this.running = false;
      this.timer = setTimeout(() => void this.tick(), this.delay);
    }
  }
}
