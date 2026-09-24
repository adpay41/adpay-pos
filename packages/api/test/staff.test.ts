/**
 * Phase 3: staff, memberships, register PINs and permissions. Runs on real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import { verifyPin, type CatalogSnapshot, type StaffMember } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { addStaff, auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let deviceA: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(deviceA) })).json();
const staffList = async (token: string): Promise<StaffMember[]> =>
  (await app.inject({ method: 'GET', url: '/merchant/staff', headers: auth(token) })).json().staff;

async function add(token: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/merchant/staff', headers: auth(token), payload: body });
}

describe('staff and register PINs', () => {
  it('an owner adds a cashier with a PIN; the register gets a hash it can verify offline, the apps never see it', async () => {
    const v = (await snapshot()).catalog_version;
    const r = await add(ownerA, { name: 'Maria Santos', role: 'cashier', pin: '2468' });
    expect(r.statusCode, r.body).toBe(201);
    const { user_id, catalog_version } = r.json();
    expect(catalog_version).toBe(v + 1);

    const snap = await snapshot();
    const member = snap.staff!.members.find((m) => m.user_id === user_id)!;
    expect(member).toMatchObject({ name: 'Maria Santos', role: 'cashier' });
    expect(member.pin_hash).toMatch(/^pbkdf2-sha256\$10000\$/);
    expect(verifyPin('2468', member.pin_hash)).toBe(true);
    expect(verifyPin('2469', member.pin_hash)).toBe(false);
    expect(member.permissions).toEqual(['ticket.void', 'cash.drop', 'item.create']);

    // The merchant app's view has no hash, and neither does the editor snapshot or the audit trail.
    const listed = await app.inject({ method: 'GET', url: '/merchant/staff', headers: auth(ownerA) });
    expect(listed.body).not.toContain('pbkdf2');
    expect(listed.json().staff.find((s: StaffMember) => s.user_id === user_id)).toMatchObject({ has_pin: true, app_access: false });
    const editor = await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(ownerA) });
    expect(editor.json().staff).toBeUndefined();
    const { rows } = await db.query<{ details: unknown }>(`SELECT details FROM audit_log WHERE target = $1`, [user_id]);
    expect(JSON.stringify(rows)).not.toMatch(/2468|pbkdf2/);
  });

  it('rejects guessable PINs', async () => {
    for (const pin of ['1234', '1111', '9876', '12', '1234567', 'abcd']) {
      const r = await add(ownerA, { name: `Weak ${pin}`, role: 'cashier', pin });
      expect(r.statusCode, pin).toBe(400);
    }
  });

  it('only people with staff.manage change staff, and only owners touch owners', async () => {
    await addStaff(db, a, 'manager', 'Luis Manager', '2015550101');
    await addStaff(db, a, 'cashier', 'Casey Cashier', '2015550102');
    const manager = await merchantLogin(app, '201-555-0101');
    const cashier = await merchantLogin(app, '201-555-0102');

    expect((await add(cashier, { name: 'X', role: 'cashier' })).statusCode).toBe(403);
    // Managers don't hold staff.manage by default either.
    expect((await add(manager, { name: 'X', role: 'cashier' })).statusCode).toBe(403);

    // The owner grants managers staff.manage; now a manager can add cashiers but not owners.
    const g = await app.inject({ method: 'PUT', url: '/merchant/permissions', headers: auth(ownerA), payload: { manager: { 'staff.manage': true } } });
    expect(g.statusCode, g.body).toBe(200);
    expect((await add(manager, { name: 'New Cashier', role: 'cashier', pin: '5813' })).statusCode).toBe(201);
    expect((await add(manager, { name: 'New Owner', role: 'owner' })).statusCode).toBe(403);
    const owner = (await staffList(ownerA)).find((s) => s.role === 'owner')!;
    expect((await app.inject({ method: 'PATCH', url: `/merchant/staff/${owner.user_id}`, headers: auth(manager), payload: { disabled: true } })).statusCode).toBe(403);
    await app.inject({ method: 'PUT', url: '/merchant/permissions', headers: auth(ownerA), payload: {} });
  });

  it('a store never loses its last active owner', async () => {
    const owner = (await staffList(ownerA)).find((s) => s.role === 'owner')!;
    const demote = await app.inject({ method: 'PATCH', url: `/merchant/staff/${owner.user_id}`, headers: auth(ownerA), payload: { role: 'manager' } });
    expect(demote.statusCode).toBe(400);
    expect(demote.json().message).toContain('at least one active owner');
    const self = await app.inject({ method: 'PATCH', url: `/merchant/staff/${owner.user_id}`, headers: auth(ownerA), payload: { disabled: true } });
    expect(self.statusCode).toBe(400);
  });

  it('role changes and removals take effect on the very next request, not when the token expires', async () => {
    const id = await addStaff(db, a, 'manager', 'Temp Manager', '2015550103');
    const token = await merchantLogin(app, '201-555-0103');
    const item = { name: 'Temp item', category_id: null, cash_price_cents: 100 };
    expect((await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(token), payload: item })).statusCode).toBe(201);

    await app.inject({ method: 'PATCH', url: `/merchant/staff/${id}`, headers: auth(ownerA), payload: { role: 'cashier' } });
    expect((await app.inject({ method: 'POST', url: '/merchant/items', headers: auth(token), payload: item })).statusCode).toBe(403);
    // Cashiers don't see sales figures by default.
    expect((await app.inject({ method: 'GET', url: '/merchant/sales/summary', headers: auth(token) })).statusCode).toBe(403);

    await app.inject({ method: 'PATCH', url: `/merchant/staff/${id}`, headers: auth(ownerA), payload: { disabled: true } });
    expect((await app.inject({ method: 'GET', url: '/merchant/catalog', headers: auth(token) })).statusCode).toBe(401);
  });

  it('anyone can set their own PIN; nobody can set a PIN at another merchant', async () => {
    const id = await addStaff(db, a, 'cashier', 'Self Service', '2015550104');
    const token = await merchantLogin(app, '201-555-0104');
    const r = await app.inject({ method: 'PUT', url: `/merchant/staff/${id}/pin`, headers: auth(token), payload: { pin: '4826' } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await snapshot()).staff!.members.some((m) => m.user_id === id)).toBe(true);

    const other = (await db.query<{ user_id: string }>('SELECT user_id FROM memberships WHERE merchant_id = $1 LIMIT 1', [b.merchant_id])).rows[0]!;
    const x = await app.inject({ method: 'PUT', url: `/merchant/staff/${other.user_id}/pin`, headers: auth(ownerA), payload: { pin: '4826' } });
    expect(x.statusCode).toBe(404);
  });

  it('permission overrides flow to the register snapshot', async () => {
    await app.inject({ method: 'PUT', url: '/merchant/permissions', headers: auth(ownerA), payload: { cashier: { 'sale.refund': true, 'cash.drop': false } } });
    const maria = (await snapshot()).staff!.members.find((m) => m.name === 'Maria Santos')!;
    expect(maria.permissions).toEqual(['ticket.void', 'sale.refund', 'item.create']);
    const bad = await app.inject({ method: 'PUT', url: '/merchant/permissions', headers: auth(ownerA), payload: { cashier: { 'launch.missiles': true } } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/merchant/permissions', headers: auth(ownerA), payload: {} });
  });

  it('disabled staff drop off the register', async () => {
    const r = await add(ownerA, { name: 'Leaving Soon', role: 'cashier', pin: '7391' });
    const id = r.json().user_id;
    expect((await snapshot()).staff!.members.some((m) => m.user_id === id)).toBe(true);
    await app.inject({ method: 'PATCH', url: `/merchant/staff/${id}`, headers: auth(ownerA), payload: { disabled: true } });
    expect((await snapshot()).staff!.members.some((m) => m.user_id === id)).toBe(false);
  });
});

describe('one person, several stores (memberships)', () => {
  it('lists the stores, switches between them, and refuses a store they do not work at', async () => {
    // Bravo's owner also manages Alpha.
    const bravoOwner = (await db.query<{ user_id: string }>(`SELECT user_id FROM users WHERE phone = '+17185550142'`)).rows[0]!.user_id;
    const add = await app.inject({ method: 'POST', url: '/merchant/staff', headers: auth(ownerA), payload: { name: 'ignored', role: 'manager', phone: '718-555-0142' } });
    expect(add.statusCode, add.body).toBe(201);
    expect(add.json().user_id).toBe(bravoOwner); // same person, new membership — not a second login

    const token = await merchantLogin(app, '718-555-0142');
    const list = (await app.inject({ method: 'GET', url: '/auth/merchant/memberships', headers: auth(token) })).json();
    expect(list.memberships.map((m: { merchant_id: string; role: string }) => [m.merchant_id, m.role])).toEqual([
      [b.merchant_id, 'owner'],
      [a.merchant_id, 'manager'],
    ]);
    expect(list.current).toBe(b.merchant_id);

    const sw = await app.inject({ method: 'POST', url: '/auth/merchant/switch', headers: auth(token), payload: { merchant_id: a.merchant_id } });
    expect(sw.statusCode, sw.body).toBe(200);
    const atAlpha = sw.json().token as string;
    expect(sw.json().principal).toMatchObject({ merchant_id: a.merchant_id, role: 'manager' });
    const cat = (await app.inject({ method: 'GET', url: '/merchant/catalog/editor', headers: auth(atAlpha) })).json();
    expect(cat.merchant_id).toBe(a.merchant_id);

    const nope = await app.inject({ method: 'POST', url: '/auth/merchant/switch', headers: auth(ownerA), payload: { merchant_id: b.merchant_id } });
    expect(nope.statusCode).toBe(404);
  });
});

describe('admin scope', () => {
  it('AD Pay admins manage any merchant’s staff', async () => {
    await createAdmin(db, 'admin@staff.local', 'correct horse battery');
    const admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@staff.local', password: 'correct horse battery' } })).json().token;
    const r = await app.inject({ method: 'POST', url: `/admin/merchants/${b.merchant_id}/staff`, headers: auth(admin), payload: { name: 'Admin Added', role: 'owner', pin: '2580' } });
    expect(r.statusCode, r.body).toBe(201);
    const list = await app.inject({ method: 'GET', url: `/admin/merchants/${b.merchant_id}/staff`, headers: auth(admin) });
    expect(list.json().staff.some((s: StaffMember) => s.name === 'Admin Added')).toBe(true);
  });
});

describe('who did it: actor on every event', () => {
  it('stores the signed-in cashier on events, and accepts staff and override events without a sale', async () => {
    const maria = (await snapshot()).staff!.members.find((m) => m.name === 'Maria Santos')!;
    const base = {
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      org_id: a.org_id,
      merchant_id: a.merchant_id,
      location_id: a.location_id,
      register_id: a.register_id,
      trace_id: 'test',
      actor_user_id: maria.user_id,
    };
    const events = [
      { ...base, event_id: randomUUID(), sale_id: null, device_seq: 900, type: 'staff.signed_in', payload: { user_id: maria.user_id, method: 'pin' } },
      { ...base, event_id: randomUUID(), sale_id: null, device_seq: 901, type: 'staff.pin_failed', payload: { user_id: maria.user_id, purpose: 'override', failures: 1, locked: false } },
      { ...base, event_id: randomUUID(), sale_id: null, device_seq: 902, type: 'override.granted', payload: { action: 'drawer.no_sale', approver_user_id: maria.user_id, for_user_id: maria.user_id } },
      { ...base, event_id: randomUUID(), sale_id: null, device_seq: 903, type: 'staff.signed_out', payload: { user_id: maria.user_id, reason: 'manual' } },
    ];
    const r = await app.inject({ method: 'POST', url: '/device/events', headers: auth(deviceA), payload: { events } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().accepted).toHaveLength(4);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sale_events WHERE actor_user_id = $1', [maria.user_id]);
    expect(rows[0]!.n).toBe(4);
  });
});
