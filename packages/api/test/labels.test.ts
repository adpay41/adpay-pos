/**
 * Phase 21 API: shelf tags as PDF with both prices, an in-store barcode for items without one, the
 * reprint queue after a price change, price labels for open-price items, label templates. Real
 * Postgres in CI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let cola: string;
let sandwich: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Labels', '201-555-2040');
  owner = await merchantLogin(app, a.owner_phone);
  const add = async (payload: object) => (await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(owner), payload: { category_id: null, ...payload } })).json().item_id as string;
  cola = await add({ name: 'Cola 20oz', cash_price_cents: 229 });
  sandwich = await add({ name: 'Turkey club', cash_price_cents: 899, open_price: true, plu: '4101' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const pdf = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth(owner), payload });

describe('shelf tags', () => {
  it('a PDF with both prices; an item without a barcode gets an in-store UPC that scans', async () => {
    const res = await pdf('/merchant/labels/shelf-tags.pdf', { item_ids: [cola], location_id: a.location_id });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const body = res.rawPayload.toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body).toContain('(Cola 20oz) Tj');
    expect(body).toContain('($2.29) Tj');
    expect(body).toContain('(card $2.38) Tj'); // 229 + 4% dual pricing
    expect(body).toMatch(/re\nf|re \nf|\nf\n/); // bars drawn
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
    const { rows } = await db.query<{ barcode: string }>('SELECT barcode FROM item_barcodes WHERE item_id = $1', [cola]);
    expect(rows[0]!.barcode).toMatch(/^4\d{11}$/);
  });

  it('after a price change the tag is in the reprint queue; printing clears it', async () => {
    const queue = async () => (await app.inject({ method: 'GET', url: `/merchant/labels/queue?location_id=${a.location_id}`, headers: auth(owner) })).json().items;
    expect(await queue()).toEqual([]);
    await app.inject({ method: 'PATCH', url: `/merchant/items/${cola}`, headers: auth(owner), payload: { cash_price_cents: 249 } });
    expect(await queue()).toEqual([expect.objectContaining({ item_id: cola, cash_price_cents: 249, printed_cash_cents: 229 })]);
    await pdf('/merchant/labels/shelf-tags.pdf', { item_ids: [cola], location_id: a.location_id });
    expect(await queue()).toEqual([]);
  });

  it('a template can drop the card price and the barcode, on thermal stock', async () => {
    const t = await app.inject({ method: 'POST', url: '/merchant/labels/templates', headers: auth(owner), payload: { name: 'Cash tag', size: 'thermal_2x1', show_card_price: false, show_barcode: false } });
    expect(t.statusCode).toBe(201);
    const templates = (await app.inject({ method: 'GET', url: '/merchant/labels/templates', headers: auth(owner) })).json().templates;
    expect(templates.map((x: { settings: { name: string } }) => x.settings.name)).toEqual(['Shelf tag', 'Cash tag']);
    const body = (await pdf('/merchant/labels/shelf-tags.pdf', { item_ids: [cola], location_id: a.location_id, template_id: t.json().template_id })).rawPayload.toString('latin1');
    expect(body).toContain('/MediaBox [0 0 162 90]');
    expect(body).not.toContain('card $');
  });
});

describe('price labels for the deli', () => {
  it('open-price item with a PLU: a label per copy; anything else is refused', async () => {
    const res = await pdf('/merchant/labels/price-labels.pdf', { item_id: sandwich, location_id: a.location_id, price_cents: 749, copies: 3 });
    expect(res.statusCode).toBe(200);
    const body = res.rawPayload.toString('latin1');
    expect(body.match(/\/Type \/Page /g)).toHaveLength(3);
    expect(body).toContain('($7.49) Tj');
    expect((await pdf('/merchant/labels/price-labels.pdf', { item_id: cola, location_id: a.location_id, price_cents: 100 })).statusCode).toBe(400);
  });
});
