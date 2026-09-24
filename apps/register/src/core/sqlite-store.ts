/**
 * SQLite event store (expo-sqlite). Same schema on the Android register and in the browser.
 * Triggers make the events table append-only at the database level, mirroring the server.
 */
import { LOG_RING_SIZE, parseRegisterEvent, type DeviceLogLine, type RegisterEvent } from '@adpay/shared';
import * as SQLite from 'expo-sqlite';
import type { AckOutcome, EventStore, StoreCounts } from './store';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  device_seq  INTEGER NOT NULL UNIQUE,
  sale_id     TEXT,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_sale ON events (sale_id, device_seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS sync_acks (
  event_id  TEXT PRIMARY KEY,
  outcome   TEXT NOT NULL,
  reason    TEXT,
  acked_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logs (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  level  TEXT NOT NULL,
  msg    TEXT NOT NULL,
  ctx    TEXT
);
`;

export class SqliteEventStore implements EventStore {
  private logWrites = 0;
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  async appendLog(line: Omit<DeviceLogLine, 'seq'>) {
    await this.db.runAsync('INSERT INTO logs (at, level, msg, ctx) VALUES (?, ?, ?, ?)', [line.at, line.level, line.msg, line.ctx ? JSON.stringify(line.ctx) : null]);
    // Trim the ring now and then rather than on every write.
    if (++this.logWrites % 200 === 0) {
      await this.db.runAsync('DELETE FROM logs WHERE seq <= (SELECT max(seq) FROM logs) - ?', [LOG_RING_SIZE]);
    }
  }

  async recentLogs(limit: number): Promise<DeviceLogLine[]> {
    const rows = await this.db.getAllAsync<{ seq: number; at: string; level: DeviceLogLine['level']; msg: string; ctx: string | null }>(
      'SELECT seq, at, level, msg, ctx FROM logs ORDER BY seq DESC LIMIT ?',
      [limit],
    );
    return rows.reverse().map((r) => ({ ...r, ctx: r.ctx ? (JSON.parse(r.ctx) as DeviceLogLine['ctx']) : null }));
  }

  static async open(name = 'adpay-register.db'): Promise<SqliteEventStore> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync(SCHEMA);
    return new SqliteEventStore(db);
  }

  private parse(rows: { body: string }[]): RegisterEvent[] {
    return rows.map((r) => parseRegisterEvent(JSON.parse(r.body)));
  }

  async nextSeq() {
    const row = await this.db.getFirstAsync<{ s: number | null }>('SELECT max(device_seq) AS s FROM events');
    return (row?.s ?? -1) + 1;
  }

  async append(e: RegisterEvent) {
    await this.db.runAsync(
      'INSERT INTO events (event_id, device_seq, sale_id, type, occurred_at, body) VALUES (?, ?, ?, ?, ?, ?)',
      [e.event_id, e.device_seq, e.sale_id, e.type, e.occurred_at, JSON.stringify(e)],
    );
  }

  async eventsForSale(saleId: string) {
    return this.parse(await this.db.getAllAsync<{ body: string }>('SELECT body FROM events WHERE sale_id = ? ORDER BY device_seq', [saleId]));
  }

  async unacked(limit: number) {
    return this.parse(
      await this.db.getAllAsync<{ body: string }>(
        `SELECT e.body FROM events e LEFT JOIN sync_acks a ON a.event_id = e.event_id
          WHERE a.event_id IS NULL ORDER BY e.device_seq LIMIT ?`,
        [limit],
      ),
    );
  }

  async ack(ids: readonly string[], outcome: AckOutcome, reason?: string) {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    await this.db.withTransactionAsync(async () => {
      for (const id of ids) {
        await this.db.runAsync('INSERT OR IGNORE INTO sync_acks (event_id, outcome, reason, acked_at) VALUES (?, ?, ?, ?)', [
          id,
          outcome,
          reason ?? null,
          now,
        ]);
      }
    });
  }

  async counts(): Promise<StoreCounts> {
    const row = await this.db.getFirstAsync<{ total: number; acked: number; rejected: number }>(
      `SELECT (SELECT count(*) FROM events) AS total,
              (SELECT count(*) FROM sync_acks) AS acked,
              (SELECT count(*) FROM sync_acks WHERE outcome = 'rejected') AS rejected`,
    );
    return { total: row?.total ?? 0, queued: (row?.total ?? 0) - (row?.acked ?? 0), rejected: row?.rejected ?? 0 };
  }

  async recentSaleIds(limit: number) {
    const rows = await this.db.getAllAsync<{ sale_id: string }>(
      `SELECT sale_id FROM events WHERE sale_id IS NOT NULL GROUP BY sale_id ORDER BY max(device_seq) DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => r.sale_id);
  }

  async getMeta(key: string) {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null) {
    if (value === null) await this.db.runAsync('DELETE FROM meta WHERE key = ?', [key]);
    else await this.db.runAsync('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
  }
}
