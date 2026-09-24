/**
 * Minimal database seam. Production and dev use node-postgres; tests use PGlite (real Postgres
 * compiled to WASM) behind the same interface, so the whole schema — partitions, triggers,
 * constraints — is exercised in CI without a database service.
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
  return {
    query: (sql, params) => run(pool, sql, params),
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
    close: () => pool.end(),
  };
}
