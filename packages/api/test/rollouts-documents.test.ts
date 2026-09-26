/**
 * Phase 24b API: staged rollouts (canary store only, then all; the kill switch beating a merchant
 * override, reaching the register's snapshot) and the documents vault (upload checked by its bytes,
 * renewal archiving the old one, expiry alert opening and resolving, another store can't read it).
 * Real Postgres in CI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { evaluateAlerts } from '../services/alerts';
import { auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let owner: string;
let device: string;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Canary', '201-555-2080');
  b = await createTenant(db, 'Rest', '201-555-2081');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const config = async (merchantId: string) => (await app.inject({ method: 'GET', url: `/admin/merchants/${merchantId}/config`, headers: auth(admin) })).json().flags;
const stage = (flag: string, payload: object) => app.inject({ method: 'PUT', url: `/admin/rollouts/${flag}`, headers: auth(admin), payload });

describe('staged rollouts', () => {
  it('canary → all, and the register snapshot follows with a new catalog version', async () => {
    const before = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    expect((await stage('price_check', { stage: 'canary', canary_merchant_ids: [], reason: 'try it' })).statusCode).toBe(400);
    const res = await stage('price_check', { stage: 'canary', canary_merchant_ids: [a.merchant_id], reason: 'first store' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stage: 'canary', on: 1, stores: 2 });
    expect((await config(a.merchant_id)).price_check).toBe(true);
    expect((await config(b.merchant_id)).price_check).toBe(false);
    const after = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    expect(after.catalog_version).toBeGreaterThan(before.catalog_version);
    expect(after.flags.price_check).toBe(true);

    await stage('price_check', { stage: 'all', reason: 'looks good' });
    expect((await config(b.merchant_id)).price_check).toBe(true);
  });

  it('the kill switch turns it off everywhere, over a store override, and is audited', async () => {
    await app.inject({ method: 'PUT', url: `/admin/merchants/${a.merchant_id}/flags`, headers: auth(admin), payload: { hold_tickets: true } });
    const res = await stage('hold_tickets', { stage: 'killed', reason: 'recall bug in the field' });
    expect(res.json()).toMatchObject({ stage: 'killed', on: 0, overridden: 1 });
    expect((await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json().flags.hold_tickets).toBe(false);
    const { rows } = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'flag.killed' AND target = 'hold_tickets'");
    expect(rows).toHaveLength(1);
    // Back to the code default: the override applies again.
    await stage('hold_tickets', { stage: 'default', reason: 'fixed' });
    expect((await config(a.merchant_id)).hold_tickets).toBe(true);
    const list = (await app.inject({ method: 'GET', url: '/admin/rollouts', headers: auth(admin) })).json().flags;
    expect(list.find((f: { flag: string }) => f.flag === 'hold_tickets').history.map((h: { stage: string }) => h.stage)).toEqual(['default', 'killed']);
  });

  it('only admins can stage a flag', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/rollouts/price_check', headers: auth(owner), payload: { stage: 'killed', reason: 'nope' } })).statusCode).toBe(403);
  });
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const upload = (token: string, query: string, body: Buffer = PDF, type = 'application/pdf') =>
  app.inject({ method: 'POST', url: `/merchant/documents?${query}`, headers: { ...auth(token), 'content-type': type }, payload: body });

describe('documents vault', () => {
  it('upload, expiry alert, renewal archives the old one and the alert resolves', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const up = await upload(owner, `kind=tobacco_licence&title=${encodeURIComponent('Tobacco licence')}&expires_on=${soon}`);
    expect(up.statusCode).toBe(201);
    const id = up.json().document_id as string;

    await evaluateAlerts(db, null, new Date());
    const open = (await app.inject({ method: 'GET', url: '/merchant/alerts', headers: auth(owner) })).json();
    const alerts = (open.alerts ?? open) as { rule: string; title: string }[];
    expect(alerts.find((x) => x.rule === 'document_expiring')?.title).toMatch(/Tobacco licence expires in (9|10) days/);

    const file = await app.inject({ method: 'GET', url: `/merchant/documents/${id}/file`, headers: auth(owner) });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.equals(PDF)).toBe(true);

    const next = new Date(Date.now() + 375 * 86_400_000).toISOString().slice(0, 10);
    const renew = await upload(owner, `kind=tobacco_licence&title=${encodeURIComponent('Tobacco licence')}&expires_on=${next}&replaces=${id}`);
    expect(renew.statusCode).toBe(201);
    expect((await upload(owner, `kind=tobacco_licence&title=Again&replaces=${id}`)).statusCode).toBe(400);
    const docs = (await app.inject({ method: 'GET', url: '/merchant/documents', headers: auth(owner) })).json().documents;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ expires_on: next, replaced: [{ document_id: id }] });

    await evaluateAlerts(db, null, new Date());
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM alerts WHERE rule = 'document_expiring' AND resolved_at IS NULL");
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses a file that isn’t what it says, and another store can’t read it', async () => {
    expect((await upload(owner, 'kind=lease&title=Lease', Buffer.from('<html>hi</html>'))).statusCode).toBe(400);
    expect((await upload(owner, 'kind=lease&title=Lease', PDF, 'image/png')).statusCode).toBe(400);
    const id = (await upload(owner, 'kind=lease&title=Lease')).json().document_id as string;
    const other = await merchantLogin(app, b.owner_phone);
    expect((await app.inject({ method: 'GET', url: `/merchant/documents/${id}/file`, headers: auth(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/merchant/documents/${id}/remove`, headers: auth(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/merchant/documents/${id}/remove`, headers: auth(owner) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/merchant/documents', headers: auth(owner) })).json().documents.some((d: { document_id: string }) => d.document_id === id)).toBe(false);
    // Support can open a store's document; that read is audited.
    expect((await app.inject({ method: 'GET', url: `/admin/documents/${id}/file`, headers: auth(admin) })).statusCode).toBe(200);
    const { rows } = await db.query("SELECT 1 FROM audit_log WHERE action = 'document.viewed' AND target = $1", [id]);
    expect(rows).toHaveLength(1);
  });
});
