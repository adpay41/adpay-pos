/**
 * NRS price book migration (ADR 0043). A small built-in price book covers the rules in CI; the
 * store's full file (9,284 items, not in the repo: it's a real store's price book) runs when it's
 * on disk: NRS_FIXTURE=/path/to/nrs-pricebook-45394-full.json, or the founder's Downloads default.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { randomUUID } from 'node:crypto';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const item = (over: Record<string, unknown>) => ({
  upc: null, plu: null, name: 'x', desc: null, size: null, dept: 'General food', qty: 1, cents: 100, cost_cents: 0, cost_qty: 1,
  includes_taxes: false, includes_fees: false, fee_multiplier: 1, byweight: false, isebt: null, ismodifier: null, variableprice: false,
  unit_upc: null, unit_count: null, numpromos: 0, status: 1, item_groups: [], ...over,
});

const BOOK = [
  item({ upc: '012000161155', plu: '012000161155', name: 'Pepsi 20oz', desc: 'Pepsi 20oz 20oz', dept: 'Drinks', cents: 249, cost_cents: 110, isebt: true }),
  item({ upc: '028200003843', plu: '028200003843', name: 'Marlboro Red', dept: 'all smoke', cents: 1399, includes_taxes: true }),
  item({ upc: '036000291452', plu: '036000291452', name: 'Kleenex', dept: 'Cleaning/Household', cents: 399 }),
  item({ upc: '036000291469', plu: '036000291469', name: 'Kleenex', dept: 'Cleaning/Household', cents: 449 }),
  item({ upc: '209014000000', plu: '09014', name: 'Egg sandwich', dept: 'General food', cents: 450 }),
  item({ upc: '200000000004', plu: '00', name: 'FAFDA', dept: 'General food', cents: 779 }),
  item({ upc: '052000044003', plu: '052000044003', name: 'Gatorade', dept: 'Drinks', cents: 0, variableprice: true }),
  item({ upc: '300450449108', plu: '300450449108', name: 'Tylenol 24ct', dept: 'Grocery Non-Taxable', cents: 899 }),
  item({ upc: '012000161162', plu: '012000161162', name: 'Pepsi 12pk', dept: 'Drinks', cents: 899, unit_upc: '012000161155', unit_count: 12 }),
];

async function nrs(owner: string, file: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/merchant/catalog/import/nrs', headers: auth(owner), payload: { file, ...extra } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('NRS price book (built-in fixture)', () => {
  let t: Tenant;
  let owner: string;
  beforeAll(async () => {
    t = await createTenant(db, 'NRS Deli', '201-555-2150');
    owner = await merchantLogin(app, t.owner_phone);
  });

  it('previews what it will do, with departments to confirm and what it cannot map', async () => {
    const p = await nrs(owner, JSON.stringify(BOOK));
    expect(p.result).toMatchObject({ dry_run: true, created: 9, updated: 0 });
    expect(p.parse.format).toBe('nrs-json');
    expect(p.parse.barcodes).toEqual({ global: 7, store: 2, none: 0 });
    const d = Object.fromEntries(p.parse.departments.map((x: { name: string }) => [x.name, x]));
    expect(d['all smoke']).toMatchObject({ restriction: 'tobacco', min_age: 21, taxable: true, exists: false });
    expect(d['Grocery Non-Taxable']).toMatchObject({ taxable: false });
    const flags = Object.fromEntries(p.parse.flags.map((f: { key: string; count: number }) => [f.key, f.count]));
    expect(flags).toMatchObject({ price_includes_tax: 1, open_price: 1, store_code: 2, short_code: 1, ebt: 1 });
    // Nothing was written.
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND attrs ? 'nrs'", [t.merchant_id]);
    expect(rows[0]!.n).toBe(0);
  });

  it('imports with the confirmed department settings; items scan by their real barcode', async () => {
    const r = await nrs(owner, JSON.stringify(BOOK), { dry_run: false, departments: { 'Cleaning/Household': { taxable: false, min_age: null, restriction: null } } });
    expect(r.result).toMatchObject({ created: 9, packs_linked: 1 });
    const { rows } = await db.query<{ name: string; upc: string; plu: string | null; cash_price_cents: number; cost_cents: number | null; open_price: boolean; nrs: { ebt: boolean | null; short_code: string | null; price_includes_tax: boolean } }>(
      `SELECT name, upc, plu, cash_price_cents::int AS cash_price_cents, cost_cents::int AS cost_cents, open_price, attrs->'nrs' AS nrs FROM items WHERE merchant_id = $1`,
      [t.merchant_id],
    );
    const by = (upc: string) => rows.find((x) => x.upc === upc)!;
    expect(rows.filter((x) => x.name === 'Kleenex')).toHaveLength(2);
    expect(by('012000161155')).toMatchObject({ cost_cents: 110, nrs: { ebt: true } });
    expect(by('209014000000').plu).toBe('09014');
    expect(by('200000000004')).toMatchObject({ plu: null, nrs: { short_code: '00' } });
    expect(by('052000044003').open_price).toBe(true);
    expect(by('028200003843').nrs.price_includes_tax).toBe(true);
    const { rows: incl } = await db.query<{ name: string }>('SELECT name FROM items WHERE merchant_id = $1 AND tax_included', [t.merchant_id]);
    expect(incl.map((x) => x.name)).toEqual(['Marlboro Red']);
    const { rows: cats } = await db.query<{ name: string; taxable: boolean; min_age: number | null; restriction: string | null }>(
      'SELECT name, taxable, min_age, restriction FROM categories WHERE merchant_id = $1',
      [t.merchant_id],
    );
    const cat = Object.fromEntries(cats.map((c) => [c.name, c]));
    expect(cat['Cleaning/Household']!.taxable).toBe(false);
    expect(cat['all smoke']).toMatchObject({ restriction: 'tobacco', min_age: 21 });
    const { rows: pack } = await db.query(`SELECT p.stock_ratio, u.upc FROM items p JOIN items u ON u.item_id = p.stock_of WHERE p.upc = '012000161162'`);
    expect(pack[0]).toMatchObject({ stock_ratio: 12, upc: '012000161155' });
  });

  it('re-uploading an updated price book updates in place, never duplicates', async () => {
    const next = BOOK.map((i) => (i.upc === '012000161155' ? { ...i, cents: 279, name: 'Pepsi 20 oz' } : i));
    const r = await nrs(owner, JSON.stringify(next), { dry_run: false });
    expect(r.result).toMatchObject({ created: 0, updated: 1, unchanged: 8 });
    const { rows } = await db.query(`SELECT name, cash_price_cents::int AS c FROM items WHERE merchant_id = $1 AND upc = '012000161155'`, [t.merchant_id]);
    expect(rows).toEqual([{ name: 'Pepsi 20 oz', c: 279 }]);
    const { rows: n } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND attrs ? 'nrs'", [t.merchant_id]);
    expect(n[0]!.n).toBe(9);
  });

  it('the portal CSV export (encrypted barcodes) imports without barcodes and re-imports by its NRS key', async () => {
    const u = await createTenant(db, 'NRS CSV', '201-555-2151');
    const o = await merchantLogin(app, u.owner_phone);
    const head = 'Upc,Department,qty,cents,incltaxes,inclfees,Name,size,ebt,byweight,"Fee Multiplier",cost_qty,cost_cents,variable_price,addstock,setstock,pack_name,pack_qty,pack_upc,unit_upc,unit_count,is_oneclick';
    const line = (hash: string, name: string, cents: number) => `"=""${hash}|45394""","General food",1,${cents},n,n,"${name}",,,n,1,1,0,n,,"=""0""",,,,,,n`;
    const csv = (c: number) => [head, line('7ae5b1c0aa', 'Kleenex', 399), line('f3392ddcbb', 'Kleenex', c)].join('\r\n');
    const first = await nrs(o, csv(449), { dry_run: false });
    expect(first.parse).toMatchObject({ format: 'nrs-csv', barcodes: { global: 0, store: 0, none: 2 } });
    expect(first.result).toMatchObject({ created: 2 });
    const again = await nrs(o, csv(499), { dry_run: false });
    expect(again.result).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    // An export whose scrambled barcodes all changed still lands on the same two items, by name.
    const rehashed = [head, line('0000aaaa11', 'Kleenex', 399), line('0000bbbb22', 'Kleenex', 499)].join('\r\n');
    const third = await nrs(o, rehashed, { dry_run: false });
    expect(third.result).toMatchObject({ created: 0, updated: 2 });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND attrs ? 'nrs'", [u.merchant_id]);
    expect(rows[0]!.n).toBe(2);
  });

  it('scan-to-attach: an item without a barcode gets the one the register scanned', async () => {
    const u = await createTenant(db, 'NRS Attach', '201-555-2154');
    const o = await merchantLogin(app, u.owner_phone);
    const head = 'Upc,Department,qty,cents,incltaxes,inclfees,Name,size,ebt,byweight,"Fee Multiplier",cost_qty,cost_cents,variable_price,unit_upc,unit_count,is_oneclick';
    await nrs(o, [head, '"=""abc123|45394""",Snacks,1,199,n,n,"Doritos Nacho",,,n,1,1,0,n,,,n'].join('\n'), { dry_run: false });
    const { rows } = await db.query<{ item_id: string }>("SELECT item_id FROM items WHERE merchant_id = $1 AND name = 'Doritos Nacho'", [u.merchant_id]);
    const itemId = rows[0]!.item_id;
    const device = await pairDevice(app, db, u.register_id);
    const attach = async (barcode: string, id = itemId) =>
      (await app.inject({ method: 'POST', url: '/device/items/barcodes', headers: auth(device), payload: { attach_id: randomUUID(), item_id: id, barcode, attached_by_user_id: null, attached_at: new Date().toISOString() } })).json();
    expect(await attach('028400090858')).toMatchObject({ status: 'attached', item_id: itemId });
    expect(await attach('0028400090858')).toMatchObject({ status: 'already' }); // the same product as EAN-13
    expect(await attach('028400090865')).toMatchObject({ status: 'attached' }); // a second barcode: extra
    const snap = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    const it = snap.items.find((i: { item_id: string }) => i.item_id === itemId);
    expect(it.upc).toBe('028400090858');
    expect(it.barcodes.map((b: { barcode: string }) => b.barcode)).toEqual(['028400090865']);
    // A barcode another item already has is left where it is.
    const { rows: other } = await db.query<{ item_id: string; upc: string }>('SELECT item_id, upc FROM items WHERE merchant_id = $1 AND upc IS NOT NULL AND item_id <> $2 LIMIT 1', [u.merchant_id, itemId]);
    expect(await attach(other[0]!.upc)).toMatchObject({ status: 'taken', item_id: other[0]!.item_id });
  });

  it('a file that is not an NRS price book is refused with a reason', async () => {
    const r = await nrs(owner, 'name,price\nCoke,1.99');
    expect(r.result).toBeNull();
    expect(r.parse.errors[0].message).toMatch(/isn't an NRS price book/);
  });
});

const FULL = process.env.NRS_FIXTURE ?? 'C:/Users/spans/Downloads/nrs-pricebook-45394-full.json';

describe.skipIf(!existsSync(FULL))('NRS price book (the store\'s full 9,284-item file)', () => {
  it('previews, imports, and re-imports as all unchanged', async () => {
    const t = await createTenant(db, 'NRS Full', '201-555-2152');
    const owner = await merchantLogin(app, t.owner_phone);
    const file = readFileSync(FULL, 'utf8');

    let t0 = Date.now();
    const preview = await nrs(owner, file);
    const previewMs = Date.now() - t0;
    expect(preview.parse).toMatchObject({ total: 9284, error_count: 0, quick_keys: 0 });
    expect(preview.parse.departments).toHaveLength(21);
    expect(preview.result).toMatchObject({ dry_run: true, created: 9284, updated: 0, unchanged: 0 });
    const existing = preview.parse.departments.filter((d: { exists: boolean }) => d.exists).length;
    expect(preview.result.categories_created).toHaveLength(21 - existing);

    t0 = Date.now();
    const done = await nrs(owner, file, { dry_run: false });
    const importMs = Date.now() - t0;
    expect(done.result).toMatchObject({ created: 9284 });
    const { rows } = await db.query<{ items: number; with_upc: number; cats: number }>(
      `SELECT count(*)::int AS items, count(upc)::int AS with_upc, count(DISTINCT category_id)::int AS cats FROM items WHERE merchant_id = $1 AND attrs ? 'nrs'`,
      [t.merchant_id],
    );
    expect(rows[0]).toEqual({ items: 9284, with_upc: 9284, cats: 21 });
    // NRS "includes taxes" → tax-inclusive items (ADR 0044), with nothing for the owner to do.
    const { rows: incl } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND tax_included AND attrs ? 'nrs'", [t.merchant_id]);
    expect(incl[0]!.n).toBe(582);

    const again = await nrs(owner, file, { dry_run: false });
    expect(again.result).toMatchObject({ created: 0, updated: 0, unchanged: 9284 });
    const flags = preview.parse.flags.map((f: { key: string; count: number }) => `${f.key}=${f.count}`).join(' ');
    process.stderr.write(`NRS full file: preview ${previewMs} ms, import ${importMs} ms ${JSON.stringify(preview.parse.barcodes)} ${flags}\n`);
  }, 300_000);
});

const FULL_CSV = process.env.NRS_FIXTURE_CSV ?? 'C:/Users/spans/Downloads/pricebook45394 (1).csv';

describe.skipIf(!existsSync(FULL_CSV))('NRS portal CSV export (the store\'s full file, scrambled barcodes)', () => {
  it('imports every row without barcodes and re-imports as unchanged', async () => {
    const t = await createTenant(db, 'NRS Full CSV', '201-555-2153');
    const owner = await merchantLogin(app, t.owner_phone);
    const file = readFileSync(FULL_CSV, 'utf8');
    const done = await nrs(owner, file, { dry_run: false });
    expect(done.parse).toMatchObject({ format: 'nrs-csv', total: 9279, error_count: 0, barcodes: { global: 0, store: 0, none: 9279 } });
    expect(done.result).toMatchObject({ created: 9279 });
    const again = await nrs(owner, file, { dry_run: false });
    expect(again.result).toMatchObject({ created: 0, updated: 0, unchanged: 9279 });
  }, 300_000);
});
