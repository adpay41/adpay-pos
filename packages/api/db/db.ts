/**
 * Minimal database seam: node-postgres everywhere that matters (dev, CI tests, production). A PGlite
 * implementation exists only for a quick local test loop and is never authoritative (ADR 0007).
 */
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run `fn` in a transaction; commits on success, rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  /**
   * LISTEN on a Postgres channel (NOTIFY is delivered on commit). Used by the realtime hub; absent
   * where the backend has no notifications. Returns a function that stops listening.
   */
  listen?(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

// BIGINT (int8) money columns and COUNT(*) come back from pg as strings by default. Parse them to
// numbers, refusing anything that would lose precision rather than silently rounding a ledger.
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value exceeds safe integer range: ${value}`);
  return n;
});

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX) || 10 });
  const run = async <T>(c: pg.Pool | pg.PoolClient, sql: string, params?: unknown[]) => {
    const r = await c.query(sql, params);
    return { rows: r.rows as T[] };
  };
  // One dedicated connection carries every LISTEN, re-established if it drops.
  const handlers = new Map<string, Set<(payload: string) => void>>();
  let listener: pg.Client | null = null;
  let connecting: Promise<pg.Client> | null = null;
  let closed = false;
  const listenerClient = (): Promise<pg.Client> => {
    if (listener) return Promise.resolve(listener);
    connecting ??= (async () => {
      const c = new pg.Client({ connectionString });
      c.on('notification', (n) => {
        for (const fn of handlers.get(n.channel) ?? []) fn(n.payload ?? '');
      });
      c.on('error', () => {
        listener = null;
        connecting = null;
        c.end().catch(() => undefined);
        if (!closed) setTimeout(() => void resubscribe(), 2_000);
      });
      await c.connect();
      for (const ch of handlers.keys()) await c.query(`LISTEN ${pg.escapeIdentifier(ch)}`);
      listener = c;
      return c;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };
  const resubscribe = async () => {
    if (closed || handlers.size === 0) return;
    await listenerClient().catch(() => setTimeout(() => void resubscribe(), 5_000));
  };

  return {
    query: (sql, params) => run(pool, sql, params),
    async listen(channel, onPayload) {
      const first = !handlers.has(channel);
      const set = handlers.get(channel) ?? new Set();
      set.add(onPayload);
      handlers.set(channel, set);
      const c = await listenerClient();
      if (first) await c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      return async () => {
        set.delete(onPayload);
      };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      closed = true;
      await listener?.end().catch(() => undefined);
      await pool.end();
    },
  };
}
