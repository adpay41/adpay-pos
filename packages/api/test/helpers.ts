/**
 * Test harness: the real migrations and the real Fastify app driven via inject(), on one of two
 * databases:
 *
 *  - TEST_DATABASE_URL set → **real Postgres**. Each test file gets its own freshly created,
 *    migrated database, dropped afterwards. This is the authoritative run and what CI uses.
 *  - unset → PGlite (Postgres compiled to WASM, in process), for a quick local loop with no Docker.
 *
 * REQUIRE_REAL_POSTGRES=1 (set in CI) makes a missing TEST_DATABASE_URL an error, so CI can never
 * silently fall back to PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { hashPassword } from '../auth/crypto';
import type { Config } from '../config';
import { createPgDb, type Db, type Queryable } from '../db/db';
import { migrate } from '../db/migrate';
import { createBaseLogger } from '../http/context';
import { createPaymentProvider } from '../payments';
import { buildApp } from '../server';
import { createLocation, createMerchant, createOrg, createRegister, issueSetupCode } from '../services/onboarding';

const int8 = (v: string) => Number(v);

export type TestBackend = 'postgres' | 'pglite';

export function testBackend(): TestBackend {
  if (process.env.TEST_DATABASE_URL) return 'postgres';
  if (process.env.REQUIRE_REAL_POSTGRES === '1') {
    throw new Error('REQUIRE_REAL_POSTGRES=1 but TEST_DATABASE_URL is not set — refusing to fall back to PGlite');
  }
  return 'pglite';
}

export async function createTestDb(): Promise<Db> {
  return testBackend() === 'postgres' ? createPostgresTestDb(process.env.TEST_DATABASE_URL!) : createPgliteTestDb();
}

/** A throwaway database on a real Postgres server, created per test file and dropped on close. */
async function createPostgresTestDb(serverUrl: string): Promise<Db> {
  const name = `adpay_test_${randomBytes(6).toString('hex')}`;
  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: serverUrl });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const db = createPgDb(url.toString());
  await migrate(db);
  return {
    ...db,
    close: async () => {
      await db.close();
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function createPgliteTestDb(): Promise<Db> {
  const pg = await PGlite.create({ parsers: { 20: int8 } });
  const wrap = (q: Pick<PGlite, 'query'>): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await q.query<T>(sql, params as unknown[]);
      return { rows: r.rows };
    },
  });
  const db: Db = {
    ...wrap(pg),
    tx: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export const TEST_CONFIG: Config = {
  env: 'test',
  port: 0,
  logLevel: 'silent',
  databaseUrl: 'pglite://memory',
  redisUrl: null,
  // Minted per run so no secret-shaped literal lives in the repo (gitleaks scans full history).
  jwtSecret: randomBytes(32).toString('hex'),
  jwtIssuer: 'adpay',
  deviceTokenTtlDays: 30,
  otpDelivery: 'log',
  corsOrigins: [],
  paymentProvider: 'stub',
};

export async function createTestApp(db: Db): Promise<FastifyInstance> {
  return buildApp({
    db,
    config: TEST_CONFIG,
    payments: createPaymentProvider('stub'),
    logger: createBaseLogger('silent'),
  });
}

export interface Tenant {
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
  owner_phone: string;
}

/** A merchant with one location and one register, plus an owner user. */
export async function createTenant(db: Db, label: string, phone: string): Promise<Tenant> {
  const org = await createOrg(db, `${label} Org`);
  const m = await db.tx((q) => createMerchant(q, { org_id: org.org_id, name: `${label} Deli` }));
  const loc = await createLocation(db, {
    merchant_id: m.merchant_id,
    name: `${label} Main St`,
    state: 'NJ',
    tax_rate_ppm: 66_250,
    dual_price_rate_ppm: 40_000,
  });
  const reg = await createRegister(db, { location_id: loc.location_id, name: 'Register 1' });
  await db.query(
    `INSERT INTO users (kind, org_id, merchant_id, role, name, phone) VALUES ('merchant_user', $1, $2, 'owner', $3, $4)`,
    [org.org_id, m.merchant_id, `${label} Owner`, `+1${phone.replace(/\D/g, '')}`],
  );
  const { rows } = await db.query<{ category_id: string }>(
    `SELECT category_id FROM categories WHERE merchant_id = $1 AND name = 'Sandwiches'`,
    [m.merchant_id],
  );
  await db.query(
    `INSERT INTO items (org_id, merchant_id, category_id, name, upc, cash_price_cents) VALUES ($1, $2, $3, 'Bacon egg & cheese', $4, 699)`,
    [org.org_id, m.merchant_id, rows[0]!.category_id, `0${Math.floor(Math.random() * 1e10)}`],
  );
  return { ...reg, owner_phone: phone };
}

export async function createAdmin(db: Db, email = 'admin@test.local', password = 'correct horse battery'): Promise<void> {
  await db.query(
    `INSERT INTO users (kind, role, name, email, password_hash) VALUES ('admin', 'platform_admin', 'Test Admin', $1, $2)`,
    [email, await hashPassword(password)],
  );
}

export async function pairDevice(app: FastifyInstance, db: Db, registerId: string): Promise<string> {
  const { code } = await db.tx((q) => issueSetupCode(q, registerId, null));
  const res = await app.inject({ method: 'POST', url: '/auth/device/pair', payload: { setup_code: code } });
  if (res.statusCode !== 200) throw new Error(`pair failed: ${res.body}`);
  return res.json().device_token as string;
}

export async function merchantLogin(app: FastifyInstance, phone: string): Promise<string> {
  const req = await app.inject({ method: 'POST', url: '/auth/merchant/otp/request', payload: { phone } });
  const { challenge_id, dev_code } = req.json();
  const res = await app.inject({ method: 'POST', url: '/auth/merchant/otp/verify', payload: { challenge_id, code: dev_code } });
  if (res.statusCode !== 200) throw new Error(`otp failed: ${res.body}`);
  return res.json().token as string;
}

/** Build a complete cash sale as the register would, returning its events. */
export function cashSaleEvents(t: Tenant, opts: { seqStart?: number; occurredAt?: string } = {}) {
  const sale_id = randomUUID();
  let seq = opts.seqStart ?? 0;
  const at = opts.occurredAt ?? new Date().toISOString();
  const base = (type: string, payload: unknown) => ({
    event_id: randomUUID(),
    schema_version: 1,
    sale_id,
    device_seq: seq++,
    occurred_at: at,
    org_id: t.org_id,
    merchant_id: t.merchant_id,
    location_id: t.location_id,
    register_id: t.register_id,
    trace_id: 'test-trace',
    type,
    payload,
  });
  const events = [
    base('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    base('sale.line_added', {
      line_id: randomUUID(), item_id: randomUUID(), name: 'Bacon egg & cheese', category_id: null, qty: 2,
      unit_cash_price_cents: 699, unit_card_price_cents: 727, taxable: true, tax_rate_ppm: 66_250, min_age: null,
    }),
    // 1398 * 6.625% = 92.6 -> 93 ; total 1491
    base('sale.tender_added', {
      tender_id: randomUUID(), tender_type: 'cash', amount_cents: 1491, tendered_cents: 2000, change_cents: 509, card: null,
    }),
    base('sale.completed', { price_mode: 'cash', subtotal_cents: 1398, tax_cents: 93, total_cents: 1491 }),
  ];
  return { sale_id, events };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
