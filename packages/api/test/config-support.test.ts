/**
 * Phase 12b API: feature flags and vertical packs per merchant (delivered in the register's
 * snapshot), and support chat (append-only, unread counts, live over /ws, behind a flag).
 * Real Postgres in CI.
 */
import type { CatalogSnapshot, ServerMessage, SupportConversation, SupportMessage } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { Db } from '../db/db';
import { addStaff, auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, testBackend, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let admin: string;
let ownerA: string;
let cashierA: string;
let ownerB: string;
let deviceA: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token;
  a = await createTenant(db, 'Foxtrot', '201-555-0300');
  b = await createTenant(db, 'Golf', '201-555-0400');
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  await addStaff(db, a, 'cashier', 'Maria Santos', '201-555-0301');
  cashierA = await merchantLogin(app, '201-555-0301');
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const as = (token: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: auth(token) }),
  put: (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: auth(token), payload }),
  post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth(token), payload }),
});
const snapshot = async (): Promise<CatalogSnapshot> => (await as(deviceA).get('/device/catalog')).json();

describe('feature flags and packs', () => {
  it('everything is on by default; a flag turned off reaches the register with a new catalog version', async () => {
    const before = await snapshot();
    expect(before.flags).toEqual({ card_payments: true, register_item_create: true, price_check: true, hold_tickets: true, support_chat: true });
    expect(before.enabled_packs).toEqual(['cstore']);

    const r = await as(admin).put(`/admin/merchants/${a.merchant_id}/flags`, { card_payments: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().overrides).toEqual({ card_payments: false });
    const after = await snapshot();
    expect(after.flags!.card_payments).toBe(false);
    expect(after.catalog_version).toBe(before.catalog_version + 1);

    expect((await as(admin).put(`/admin/merchants/${a.merchant_id}/flags`, { teleport: true })).statusCode).toBe(400);
    expect((await as(ownerA).put(`/admin/merchants/${a.merchant_id}/flags`, {})).statusCode).toBe(403);
  });

  it('packs: turning one on seeds its categories once; a stub pack is allowed and adds nothing', async () => {
    const count = async () => (await snapshot()).categories.length;
    const n = await count();
    expect((await as(admin).put(`/admin/merchants/${a.merchant_id}/packs`, { enabled_packs: ['liquor'] })).statusCode).toBe(200);
    expect(await count()).toBe(n); // stub; categories stay when cstore goes off
    expect((await as(admin).put(`/admin/merchants/${a.merchant_id}/packs`, { enabled_packs: ['cstore', 'liquor'] })).statusCode).toBe(200);
    expect(await count()).toBe(n); // cstore's categories already exist by name: no duplicates
    expect((await snapshot()).enabled_packs).toEqual(['cstore', 'liquor']);
    expect((await as(admin).put(`/admin/merchants/${a.merchant_id}/packs`, { enabled_packs: [] })).statusCode).toBe(400);
  });
});

describe('support chat', () => {
  it('a message from the store shows unread in AD Pay’s inbox until opened; the reply reaches the store', async () => {
    // Any staff member with the app can write, not only people who see the figures.
    const sent = await as(cashierA).post('/merchant/support', { body: 'Printer says paper jam' });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ author_kind: 'merchant_user', author_name: 'Maria Santos', body: 'Printer says paper jam' });

    let inbox = (await as(admin).get('/admin/support')).json().conversations as SupportConversation[];
    expect(inbox.find((c) => c.merchant_id === a.merchant_id)).toMatchObject({ unread: 1, merchant_name: 'Foxtrot Deli' });
    await as(admin).get(`/admin/support/${a.merchant_id}`);
    inbox = (await as(admin).get('/admin/support')).json().conversations;
    expect(inbox.find((c) => c.merchant_id === a.merchant_id)!.unread).toBe(0);

    expect((await as(admin).post(`/admin/support/${a.merchant_id}`, { body: 'Open the lid, pull the roll, close firmly.' })).statusCode).toBe(201);
    const thread = (await as(ownerA).get('/merchant/support')).json().messages as SupportMessage[];
    expect(thread.map((m) => m.author_kind)).toEqual(['merchant_user', 'admin']);
    // Another store sees only its own conversation.
    expect((await as(ownerB).get('/merchant/support')).json().messages).toEqual([]);
  });

  it('is append-only, validates, and can be switched off per merchant', async () => {
    await expect(db.query("UPDATE support_messages SET body = 'edited'")).rejects.toThrow(/append-only/);
    expect((await as(ownerA).post('/merchant/support', { body: '   ' })).statusCode).toBe(400);
    await as(admin).put(`/admin/merchants/${b.merchant_id}/flags`, { support_chat: false });
    expect((await as(ownerB).post('/merchant/support', { body: 'hello?' })).statusCode).toBe(403);
  });

  it.skipIf(testBackend() !== 'postgres')('arrives live: the store’s users and AD Pay get it, another store does not', async () => {
    const open = async (token: string) => {
      const ws: WebSocket = await app.injectWS('/ws');
      const got: ServerMessage[] = [];
      ws.on('message', (m) => got.push(JSON.parse(String(m)) as ServerMessage));
      ws.send(JSON.stringify({ type: 'auth', token }));
      return { ws, got };
    };
    const until = async (got: ServerMessage[], pred: (m: ServerMessage) => boolean) => {
      for (let i = 0; i < 120 && !got.some(pred); i++) await new Promise((r) => setTimeout(r, 25));
      return got.find(pred);
    };
    const store = await open(ownerA);
    const adpay = await open(admin);
    const other = await open(ownerB);
    await until(store.got, (m) => m.type === 'ready');
    await until(adpay.got, (m) => m.type === 'ready');
    const reply = (await as(admin).post(`/admin/support/${a.merchant_id}`, { body: 'Fixed?' })).json() as SupportMessage;
    const isIt = (m: ServerMessage) => m.type === 'support' && m.message.message_id === reply.message_id;
    expect(await until(store.got, isIt)).toBeTruthy();
    expect(await until(adpay.got, isIt)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    expect(other.got.some(isIt)).toBe(false);
    for (const c of [store, adpay, other]) c.ws.terminate();
  });
});
