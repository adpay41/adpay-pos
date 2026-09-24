/**
 * Local demo data — `pnpm db:seed` (run automatically by `pnpm dev`).
 *
 * Creates two tenants so isolation is visible:
 *   Hudson Retail Group → Journal Square Deli & Grocery → Jersey City NJ (2 registers + 1 unpaired)
 *                                                       → Astoria NY (1 register)
 *   Bayonne Corner Mart  → Bayonne NJ (1 register)
 * plus an AD Pay admin, merchant owners with phone logins, a full c-store catalog, and three weeks of
 * sales history written through the real ingest path as immutable events (card sales go through the
 * stub PaymentProvider — nothing reaches a processor).
 *
 * Idempotent: does nothing if the demo org already exists. `--reset` wipes the local database first.
 * Refuses to run with NODE_ENV=production.
 */
import { randomUUID } from 'node:crypto';
import { foldSale, parseRegisterEvent, resolveDualPrice, type RegisterEvent } from '@adpay/shared';
import { hashPassword, hashSetupCode } from '../auth/crypto';
import type { DevicePrincipal } from '../auth/principal';
import { loadDatabaseUrl } from '../config';
import { createPgDb, type Db } from '../db/db';
import { migrate } from '../db/migrate';
import { createPaymentProvider } from '../payments';
import { ingestEvents } from '../services/events';
import { createLocation, createMerchant, createOrg, createRegister } from '../services/onboarding';
import { CATEGORIES, ITEMS, syntheticUpc } from './seed-data';

if (process.env.NODE_ENV === 'production') {
  console.error('[seed] refusing to seed a production database');
  process.exit(1);
}

const DEMO_ORG = 'Hudson Retail Group';
const ADMIN_EMAIL = 'admin@adpay.local';
// Local-only demo credential for a throwaway database; not a secret. Override with SEED_ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'adpay-demo';
const HISTORY_DAYS = 21;
const TZ = 'America/New_York';

// ── deterministic randomness ────────────────────────────────────────────────────────────────
let rngState = 20260923;
function rand(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function pickWeighted<T extends { weight?: number }>(list: readonly T[]): T {
  const total = list.reduce((s, x) => s + (x.weight ?? 1), 0);
  let r = rand() * total;
  for (const x of list) {
    r -= x.weight ?? 1;
    if (r <= 0) return x;
  }
  return list[list.length - 1]!;
}

// ── time helpers (no date library) ──────────────────────────────────────────────────────────
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}
/** Wall-clock time in `tz` → UTC Date. */
function zoned(y: number, m: number, d: number, h: number, min: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  return new Date(guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz));
}
function localToday(tz: string): { y: number; m: number; d: number } {
  const now = Date.now();
  const local = new Date(now + tzOffsetMs(now, tz));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

// ── catalog ─────────────────────────────────────────────────────────────────────────────────
interface CatalogRow {
  item_id: string;
  category_id: string;
  category: string;
  name: string;
  cash_price_cents: number;
  card_price_cents: number | null;
  taxable: boolean;
  min_age: number | null;
  weight: number;
}

/** Typical cost as a percent of the cash price, by category (demo data only). */
const COST_PERCENT: Record<string, number> = {
  Sandwiches: 40, Drinks: 55, Snacks: 60, Tobacco: 88, Lottery: 95, Grocery: 72, Household: 60,
};

async function seedCatalog(db: Db, org_id: string, merchant_id: string, upcStart: number): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let upc = upcStart;
  for (const [sort, c] of CATEGORIES.entries()) {
    const { rows: cat } = await db.query<{ category_id: string }>(
      `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, color, pack)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'cstore') RETURNING category_id`,
      [org_id, merchant_id, c.name, sort, c.taxable, c.min_age, c.color],
    );
    const category_id = cat[0]!.category_id;
    for (const item of ITEMS[c.name] ?? []) {
      // Demo cost at a typical c-store cost ratio for the category, in integer cents.
      const cost = Math.floor((item.cash * (COST_PERCENT[c.name] ?? 65) + 50) / 100);
      const { rows: ins } = await db.query<{ item_id: string }>(
        `INSERT INTO items (org_id, merchant_id, category_id, name, sku, upc, cash_price_cents, card_price_cents, sell_unit, pack_qty, attrs, cost_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING item_id`,
        [
          org_id, merchant_id, category_id, item.name, `SKU-${upc}`, syntheticUpc(upc), item.cash, item.card ?? null,
          item.pack ? 'pack' : 'each', item.pack ?? 1, JSON.stringify(item.pack ? { case_break: { units: item.pack } } : {}), cost,
        ],
      );
      await db.query(
        `INSERT INTO item_price_history (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, cost_cents,
                                         catalog_version, changed_by_kind, changed_at, trace_id)
         SELECT $1, $2, $3, $4, $5, $6, catalog_version, 'seed', now() - interval '30 days', 'seed' FROM merchants WHERE merchant_id = $2`,
        [org_id, merchant_id, ins[0]!.item_id, item.cash, item.card ?? null, cost],
      );
      upc++;
      rows.push({
        item_id: ins[0]!.item_id,
        category_id,
        category: c.name,
        name: item.name,
        cash_price_cents: item.cash,
        card_price_cents: item.card ?? null,
        taxable: c.taxable,
        min_age: c.min_age,
        weight: item.weight ?? 1,
      });
    }
  }
  return rows;
}

// ── sales history ───────────────────────────────────────────────────────────────────────────
interface RegisterSim {
  device: DevicePrincipal;
  label: string;
  perDay: number;
  taxRatePpm: number;
  dualRatePpm: number;
  catalog: CatalogRow[];
  seq: number;
}

// Share of the day's traffic in each local hour, 6am–10pm: breakfast rush, lunch, after-work.
const HOUR_WEIGHTS: Record<number, number> = {
  6: 6, 7: 10, 8: 11, 9: 8, 10: 5, 11: 6, 12: 9, 13: 8, 14: 5, 15: 5, 16: 6, 17: 8, 18: 7, 19: 5, 20: 4, 21: 3, 22: 2,
};

function basket(catalog: CatalogRow[], hour: number): CatalogRow[] {
  const inCat = (name: string) => catalog.filter((c) => c.category === name);
  const pick = (name: string) => pickWeighted(inCat(name));
  const lines: CatalogRow[] = [];
  const r = rand();
  if (hour < 11 && r < 0.6) {
    lines.push(pickWeighted(inCat('Sandwiches').slice(0, 5)));
    if (chance(0.3)) lines.push(pickWeighted(inCat('Sandwiches').slice(0, 5))); // one for a coworker
    if (chance(0.85)) lines.push(pickWeighted(inCat('Drinks').slice(0, 4)));
    if (chance(0.3)) lines.push(pick('Drinks'));
    if (chance(0.15)) lines.push(pick('Lottery'));
  } else if (hour >= 11 && hour < 15 && r < 0.6) {
    lines.push(pickWeighted(inCat('Sandwiches').slice(5)));
    if (chance(0.2)) lines.push(pickWeighted(inCat('Sandwiches').slice(5)));
    if (chance(0.85)) lines.push(pickWeighted(inCat('Drinks').slice(4)));
    if (chance(0.55)) lines.push(pick('Snacks'));
  } else if (r < 0.66) {
    // Grab-and-go: drinks and snacks, often tobacco or lottery on top.
    lines.push(chance(0.6) ? pickWeighted(inCat('Drinks').slice(4)) : pick('Snacks'));
    lines.push(pick('Snacks'));
    if (chance(0.3)) lines.push(pickWeighted(inCat('Drinks').slice(4)));
    if (chance(0.25)) lines.push(pick('Tobacco'));
    if (chance(0.2)) lines.push(pick('Lottery'));
  } else if (r < 0.86) {
    lines.push(pick('Tobacco'));
    if (chance(0.35)) lines.push(pick('Lottery'));
    if (chance(0.3)) lines.push(pickWeighted(inCat('Drinks').slice(4)));
    if (chance(0.25)) lines.push(inCat('Household').find((i) => i.name.includes('Lighter')) ?? pick('Household'));
  } else {
    const n = randInt(3, 7);
    for (let i = 0; i < n; i++) lines.push(chance(0.8) ? pick('Grocery') : pick('Household'));
  }
  return lines;
}

async function simulateSale(sim: RegisterSim, at: Date, hour: number, stub: ReturnType<typeof createPaymentProvider>) {
  const sale_id = randomUUID();
  const d = sim.device;
  const events: RegisterEvent[] = [];
  let t = at.getTime();
  const push = (type: string, payload: unknown) => {
    t += randInt(2, 9) * 1000;
    events.push(
      parseRegisterEvent({
        event_id: randomUUID(), schema_version: 1, sale_id, device_seq: sim.seq++,
        occurred_at: new Date(t).toISOString(), org_id: d.org_id, merchant_id: d.merchant_id,
        location_id: d.location_id, register_id: d.register_id, trace_id: `seed-${sale_id.slice(0, 8)}`, type, payload,
      }),
    );
  };

  push('sale.opened', { cashier_user_id: null, catalog_version: 1 });
  const items = basket(sim.catalog, hour);
  for (const item of items) {
    const price = resolveDualPrice(item, sim.dualRatePpm);
    const line_id = randomUUID();
    const qty = item.category === 'Grocery' && item.name === 'Banana' ? randInt(1, 6) : chance(0.08) ? 2 : 1;
    push('sale.line_added', {
      line_id, item_id: item.item_id, name: item.name, category_id: item.category_id, qty,
      unit_cash_price_cents: price.cash, unit_card_price_cents: price.card,
      taxable: item.taxable, tax_rate_ppm: item.taxable ? sim.taxRatePpm : 0, min_age: item.min_age,
    });
    if (item.min_age) push('sale.age_verified', { line_id, method: 'manual', verified_by_user_id: null });
    if (item.category === 'Sandwiches' && chance(0.04)) {
      push('sale.line_discounted', { line_id, cash_discount_cents: 50, card_discount_cents: 50, reason: 'Regular customer' });
    }
  }

  if (chance(0.015)) {
    push('sale.voided', { reason: chance(0.5) ? 'Customer changed mind' : 'Rung up in error', by_user_id: null });
    return events;
  }

  const mode = chance(0.55) ? 'card' : 'cash';
  const folded = foldSale(sale_id, events);
  const totals = mode === 'card' ? folded.card : folded.cash;
  const tender_id = randomUUID();
  if (mode === 'cash') {
    const total = totals.total_cents;
    const bills = [100, 500, 1000, 2000, 5000, 10000];
    const tendered = chance(0.15) ? total : (bills.find((b) => b >= total) ?? Math.ceil(total / 10000) * 10000);
    push('sale.tender_added', {
      tender_id, tender_type: 'cash', amount_cents: total, tendered_cents: tendered, change_cents: tendered - total, card: null,
    });
  } else {
    const r = await stub.terminalCharge({
      tenancy: d, terminal_id: `A35-${d.register_id.slice(0, 6)}`, amount_cents: totals.total_cents,
      idempotency_key: tender_id, sale_id,
    });
    push('sale.tender_added', {
      tender_id, tender_type: 'card', amount_cents: r.amount_cents, tendered_cents: null, change_cents: null,
      card: {
        provider: stub.name, provider_ref: r.provider_ref, status: 'approved', approval_code: r.approval_code,
        brand: r.card?.brand ?? null, last4: r.card?.last4 ?? null,
      },
    });
  }
  push('sale.completed', { price_mode: mode, ...totals });
  push('receipt.printed', { copy: chance(0.35) ? 'original' : 'none' });
  if (mode === 'cash') push('drawer.opened', { reason: 'cash_sale', by_user_id: null });

  if (chance(0.005)) {
    push('sale.refunded', {
      refund_id: randomUUID(), tender_type: mode, amount_cents: totals.total_cents, reason: 'Item returned',
      by_user_id: null, card: null,
    });
  }
  return events;
}

async function seedHistory(db: Db, sims: RegisterSim[]) {
  const stub = createPaymentProvider('stub');
  const today = localToday(TZ);
  const now = Date.now();
  let total = 0;
  for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const weekend = [0, 6].includes(day.getUTCDay());
    for (const sim of sims) {
      const dayCount = Math.round(sim.perDay * (weekend ? 0.85 : 1) * (0.85 + rand() * 0.3));
      const weightSum = Object.values(HOUR_WEIGHTS).reduce((a, b) => a + b, 0);
      for (const [hourStr, w] of Object.entries(HOUR_WEIGHTS)) {
        const hour = Number(hourStr);
        const n = Math.round((dayCount * w) / weightSum);
        const batch: RegisterEvent[] = [];
        const starts = Array.from({ length: n }, () => randInt(0, 3540)).sort((a, b) => a - b);
        for (const offset of starts) {
          const at = zoned(y, m, d, hour, Math.floor(offset / 60), offset % 60, TZ);
          if (at.getTime() > now - 60_000) continue; // nothing in the future
          const saleEvents = await simulateSale(sim, at, hour, stub);
          // Events carry a device time; never let the simulated clock run past "now".
          if (saleEvents.some((e) => Date.parse(e.occurred_at) > now)) continue;
          batch.push(...saleEvents);
          total++;
        }
        if (batch.length === 0) continue;
        // Registers sync continuously; model it as one push at the end of each hour.
        const receivedAt = new Date(Math.min(zoned(y, m, d, hour, 59, 59, TZ).getTime(), now));
        const lastEvent = Math.max(...batch.map((e) => Date.parse(e.occurred_at)));
        const result = await ingestEvents(db, sim.device, batch, {
          receivedAt: new Date(Math.max(receivedAt.getTime(), Math.min(lastEvent + 5_000, now))),
        });
        if (result.rejected.length) throw new Error(`seed events rejected: ${JSON.stringify(result.rejected[0])}`);
      }
    }
    process.stdout.write(`\r[seed] sales history: ${HISTORY_DAYS - back}/${HISTORY_DAYS} days, ${total} sales`);
  }
  process.stdout.write('\n');
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const db = createPgDb(loadDatabaseUrl());
  try {
    if (process.argv.includes('--reset')) {
      console.log('[seed] --reset: dropping and recreating the local database schema');
      await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await migrate(db, (m) => console.log(`[seed] migrate: ${m}`));

    const { rows: existing } = await db.query('SELECT 1 FROM orgs WHERE name = $1', [DEMO_ORG]);
    if (existing.length) {
      console.log('[seed] demo data already present — skipping (use `pnpm dev:reset` to start over)');
      await printLogins(db);
      return;
    }

    console.log('[seed] creating demo tenants, users and catalog');
    await db.query(
      `INSERT INTO users (kind, role, name, email, password_hash) VALUES ('admin', 'platform_admin', 'AD Pay Support', $1, $2)`,
      [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)],
    );

    // Tenant 1: two locations across NJ and NY, different tax rates.
    const org = await createOrg(db, DEMO_ORG);
    const jsq = await db.tx((q) =>
      createMerchant(q, { org_id: org.org_id, name: 'Journal Square Deli & Grocery', legal_name: 'JSQ Deli Grocery LLC', seed_pack_categories: false }),
    );
    const jc = await createLocation(db, {
      merchant_id: jsq.merchant_id, name: 'Jersey City', address_line1: '118 Newark Ave', city: 'Jersey City',
      state: 'NJ', postal_code: '07302', tax_rate_ppm: 66_250, dual_price_rate_ppm: 40_000,
    });
    const ast = await createLocation(db, {
      merchant_id: jsq.merchant_id, name: 'Astoria', address_line1: '31-20 Ditmars Blvd', city: 'Astoria',
      state: 'NY', postal_code: '11105', tax_rate_ppm: 88_750, dual_price_rate_ppm: 35_000,
    });
    const jc1 = await createRegister(db, { location_id: jc.location_id, name: 'Register 1' });
    const jc2 = await createRegister(db, { location_id: jc.location_id, name: 'Register 2' });
    await createRegister(db, { location_id: jc.location_id, name: 'Register 3 (new)' });
    const ast1 = await createRegister(db, { location_id: ast.location_id, name: 'Register 1' });
    const jsqCatalog = await seedCatalog(db, org.org_id, jsq.merchant_id, 10_000);

    // Tenant 2: a separate org, to show isolation.
    const org2 = await createOrg(db, 'Bayonne Corner Mart');
    const bcm = await db.tx((q) =>
      createMerchant(q, { org_id: org2.org_id, name: 'Bayonne Corner Mart', legal_name: 'BCM Food Corp', seed_pack_categories: false }),
    );
    const bay = await createLocation(db, {
      merchant_id: bcm.merchant_id, name: 'Broadway', address_line1: '742 Broadway', city: 'Bayonne',
      state: 'NJ', postal_code: '07002', tax_rate_ppm: 66_250, dual_price_rate_ppm: 40_000,
    });
    const bay1 = await createRegister(db, { location_id: bay.location_id, name: 'Register 1' });
    const bcmCatalog = await seedCatalog(db, org2.org_id, bcm.merchant_id, 20_000);

    const users: [string, string, string, string, string][] = [
      [org.org_id, jsq.merchant_id, 'owner', 'Nadia Haddad', '+12015550100'],
      [org.org_id, jsq.merchant_id, 'manager', 'Luis Ortega', '+12015550101'],
      [org2.org_id, bcm.merchant_id, 'owner', 'Kevin Walsh', '+12015550142'],
    ];
    for (const [o, m, role, name, phone] of users) {
      await db.query(
        `INSERT INTO users (kind, org_id, merchant_id, role, name, phone) VALUES ('merchant_user', $1, $2, $3, $4, $5)`,
        [o, m, role, name, phone],
      );
    }

    // Registers with history are "already paired" devices in the field.
    for (const r of [jc1, jc2, ast1, bay1]) {
      await db.query(`UPDATE registers SET status = 'active', paired_at = now() - interval '30 days' WHERE register_id = $1`, [
        r.register_id,
      ]);
    }

    const sim = (r: typeof jc1, label: string, perDay: number, tax: number, dual: number, catalog: CatalogRow[]): RegisterSim => ({
      device: { kind: 'device', ...r }, label, perDay, taxRatePpm: tax, dualRatePpm: dual, catalog, seq: 0,
    });
    await seedHistory(db, [
      sim(jc1, 'JC R1', 95, 66_250, 40_000, jsqCatalog),
      sim(jc2, 'JC R2', 55, 66_250, 40_000, jsqCatalog),
      sim(ast1, 'AST R1', 80, 88_750, 35_000, jsqCatalog),
      sim(bay1, 'BAY R1', 70, 66_250, 40_000, bcmCatalog),
    ]);

    await printLogins(db);
  } finally {
    await db.close();
  }
}

/**
 * Fixed, documented setup codes for the demo registers (local dev only), so anyone can pair a
 * register from the README without reading a terminal. Every seed run — i.e. every `npm run dev`
 * or `npm run logins` — re-arms them, so a code that was already used works again.
 * Registers created later in admin get random codes from Admin → Merchants → Setup code.
 */
const DEMO_SETUP_CODES: Record<string, string> = {
  'Journal Square Deli & Grocery · Jersey City · Register 3 (new)': 'JSQ3-DEMO',
  'Journal Square Deli & Grocery · Jersey City · Register 1': 'JSQ1-DEMO',
  'Journal Square Deli & Grocery · Jersey City · Register 2': 'JSQ2-DEMO',
  'Journal Square Deli & Grocery · Astoria · Register 1': 'AST1-DEMO',
  'Bayonne Corner Mart · Broadway · Register 1': 'BAY1-DEMO',
};
const DEV_OTP_CODE = process.env.DEV_OTP_CODE || '123456';

async function armDemoSetupCode(db: Db, registerId: string, code: string) {
  const hash = hashSetupCode(code);
  await db.tx(async (q) => {
    await q.query(`UPDATE register_setup_codes SET expires_at = now() WHERE register_id = $1 AND used_at IS NULL AND expires_at > now()`, [
      registerId,
    ]);
    await q.query(`DELETE FROM register_setup_codes WHERE code_hash = $1`, [hash]);
    await q.query(
      `INSERT INTO register_setup_codes (code_hash, org_id, merchant_id, location_id, register_id, expires_at)
       SELECT $1, org_id, merchant_id, location_id, register_id, now() + interval '365 days' FROM registers WHERE register_id = $2`,
      [hash, registerId],
    );
  });
}

async function printLogins(db: Db) {
  const { rows } = await db.query<{ register_id: string; label: string }>(
    `SELECT r.register_id, m.name || ' · ' || l.name || ' · ' || r.name AS label
       FROM registers r JOIN locations l USING (location_id) JOIN merchants m ON m.merchant_id = r.merchant_id
      ORDER BY m.name, l.name, r.name`,
  );
  const codes: string[] = [];
  for (const r of rows) {
    const code = DEMO_SETUP_CODES[r.label];
    if (!code) continue;
    await armDemoSetupCode(db, r.register_id, code);
    codes.push(`    ${code}   ${r.label}`);
  }
  console.log(
    [
      '',
      '──────────────────────────── AD Pay demo logins (local only) ────────────────────────────',
      `  Admin back-office    http://localhost:3001   ${ADMIN_EMAIL}  /  ${ADMIN_PASSWORD}   (platform admin)`,
      `  Merchant app         http://localhost:8081   phone (201) 555-0100, then code ${DEV_OTP_CODE}`,
      '                       (201) 555-0100 Nadia Haddad, owner · (201) 555-0101 Luis Ortega, manager',
      '                       (201) 555-0142 Kevin Walsh, owner of the separate Bayonne tenant',
      `                       Dev mode sends no SMS; the code is always ${DEV_OTP_CODE} (also shown on screen).`,
      '  Register             http://localhost:8082   enter a setup code:',
      ...codes,
      '                       Codes are re-armed on every `npm run dev` or `npm run logins`.',
      '──────────────────────────────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

await main();
