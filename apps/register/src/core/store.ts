/**
 * The register's local source of truth (ADR 0002): an append-only event log plus a little metadata.
 *
 * Events are never updated or deleted. Sync progress is recorded in a separate acks table, so
 * "has the server got this?" never requires touching the event itself. Two implementations share
 * this interface: SQLite (expo-sqlite, on Android and in the browser) and in-memory (tests).
 */
import { LOG_RING_SIZE, type DeviceLogLine, type RegisterEvent } from '@adpay/shared';

export type AckOutcome = 'accepted' | 'duplicate' | 'rejected';

export interface StoreCounts {
  total: number;
  queued: number;
  rejected: number;
}

export interface EventStore {
  /** Next device_seq: one more than the highest ever stored. */
  nextSeq(): Promise<number>;
  append(event: RegisterEvent): Promise<void>;
  eventsForSale(saleId: string): Promise<RegisterEvent[]>;
  /** Every event from `seq` on, in order (the drawer folds a session from its opening event). */
  eventsSince(seq: number): Promise<RegisterEvent[]>;
  /** Oldest-first events the server has not acknowledged. */
  unacked(limit: number): Promise<RegisterEvent[]>;
  ack(eventIds: readonly string[], outcome: AckOutcome, reason?: string): Promise<void>;
  counts(): Promise<StoreCounts>;
  /** Most recent sale ids, newest first. */
  recentSaleIds(limit: number): Promise<string[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
  /** Local log ring (P4): keeps the last LOG_RING_SIZE lines; uploaded when the office asks. */
  appendLog(line: Omit<DeviceLogLine, 'seq'>): Promise<void>;
  recentLogs(limit: number): Promise<DeviceLogLine[]>;
}

export class MemoryEventStore implements EventStore {
  private events: RegisterEvent[] = [];
  private acks = new Map<string, AckOutcome>();
  private meta = new Map<string, string>();
  private logs: DeviceLogLine[] = [];
  private logSeq = 0;

  async nextSeq() {
    return this.events.reduce((m, e) => Math.max(m, e.device_seq), -1) + 1;
  }
  async append(event: RegisterEvent) {
    if (this.events.some((e) => e.event_id === event.event_id)) throw new Error(`duplicate event ${event.event_id}`);
    if (this.events.some((e) => e.device_seq === event.device_seq)) throw new Error(`duplicate device_seq ${event.device_seq}`);
    this.events.push(event);
  }
  async eventsForSale(saleId: string) {
    return this.events.filter((e) => e.sale_id === saleId).sort((a, b) => a.device_seq - b.device_seq);
  }
  async eventsSince(seq: number) {
    return this.events.filter((e) => e.device_seq >= seq).sort((a, b) => a.device_seq - b.device_seq);
  }
  async unacked(limit: number) {
    return this.events
      .filter((e) => !this.acks.has(e.event_id))
      .sort((a, b) => a.device_seq - b.device_seq)
      .slice(0, limit);
  }
  async ack(ids: readonly string[], outcome: AckOutcome) {
    for (const id of ids) if (!this.acks.has(id)) this.acks.set(id, outcome);
  }
  async counts() {
    const rejected = [...this.acks.values()].filter((o) => o === 'rejected').length;
    return { total: this.events.length, queued: this.events.length - this.acks.size, rejected };
  }
  async recentSaleIds(limit: number) {
    const seen: string[] = [];
    for (const e of [...this.events].sort((a, b) => b.device_seq - a.device_seq)) {
      if (e.sale_id && !seen.includes(e.sale_id)) seen.push(e.sale_id);
      if (seen.length >= limit) break;
    }
    return seen;
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string | null) {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
  async appendLog(line: Omit<DeviceLogLine, 'seq'>) {
    this.logs.push({ ...line, seq: this.logSeq++ });
    if (this.logs.length > LOG_RING_SIZE) this.logs.splice(0, this.logs.length - LOG_RING_SIZE);
  }
  async recentLogs(limit: number) {
    return this.logs.slice(-limit);
  }
  /** Test helper: prove immutability expectations. */
  snapshot(): readonly RegisterEvent[] {
    return this.events;
  }
}
