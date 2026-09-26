/**
 * Phase 24a API: support tickets (SLA, first response, canned fix pressing the remote action on the
 * ticket's register, internal notes hidden from the store, a store reply reopening it) and hardware
 * (stock → installed → swap to RMA → repaired). Real Postgres in CI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createAdmin, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  await createAdmin(db);
  a = await createTenant(db, 'Support', '201-555-2070');
  owner = await merchantLogin(app, a.owner_phone);
  await pairDevice(app, db, a.register_id);
  admin = (await app.inject({ method: 'POST', url: '/auth/admin/login', payload: { email: 'admin@test.local', password: 'correct horse battery' } })).json().token as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('support tickets', () => {
  it('a store reports a problem; AD Pay answers with a canned fix that presses the button on the register', async () => {
    const t = await app.inject({ method: 'POST', url: '/merchant/tickets', headers: auth(owner), payload: { subject: 'Receipts come out blank', register_id: a.register_id } });
    expect(t.statusCode).toBe(201);
    const id = t.json().ticket_id as string;
    const list = (await app.inject({ method: 'GET', url: '/admin/tickets?status=active', headers: auth(admin) })).json().tickets;
    const row = list.find((x: { ticket_id: string }) => x.ticket_id === id);
    expect(row).toMatchObject({ category: 'hardware', priority: 'normal', status: 'open', first_response_at: null, source: 'merchant' });
    expect(Date.parse(row.sla_due_at) - Date.parse(row.created_at)).toBe(24 * 3_600_000);

    const fix = await app.inject({ method: 'POST', url: `/admin/tickets/${id}/notes`, headers: auth(admin), payload: { canned_fix: 'printer_paper', status: 'pending' } });
    expect(fix.statusCode).toBe(200);
    expect(fix.json().action_id).toBeTruthy();
    const { rows } = await db.query<{ kind: string; status: string }>('SELECT kind, status FROM remote_actions WHERE action_id = $1', [fix.json().action_id]);
    expect(rows[0]).toMatchObject({ kind: 'printer_test', status: 'queued' });

    await app.inject({ method: 'POST', url: `/admin/tickets/${id}/notes`, headers: auth(admin), payload: { body: 'Probably the thermal roll is in upside down', internal: true } });
    const mine = (await app.inject({ method: 'GET', url: `/merchant/tickets/${id}`, headers: auth(owner) })).json();
    expect(mine.status).toBe('pending');
    expect(mine.first_response_at).not.toBeNull();
    expect(mine.notes.map((n: { body: string }) => n.body).join(' ')).toContain('80 mm roll');
    expect(mine.notes.some((n: { body: string }) => n.body.includes('upside down'))).toBe(false); // internal

    // The store replies: back in AD Pay's queue.
    await app.inject({ method: 'POST', url: `/merchant/tickets/${id}/notes`, headers: auth(owner), payload: { body: 'Still blank' } });
    expect((await app.inject({ method: 'GET', url: `/admin/tickets/${id}`, headers: auth(admin) })).json().status).toBe('open');
  });

  it('a fix that needs a register refuses a ticket without one; urgent tickets are due in 4 hours', async () => {
    const id = (await app.inject({ method: 'POST', url: '/admin/tickets', headers: auth(admin), payload: { merchant_id: a.merchant_id, subject: 'Prices wrong at the register', priority: 'urgent' } })).json().ticket_id;
    expect((await app.inject({ method: 'POST', url: `/admin/tickets/${id}/notes`, headers: auth(admin), payload: { canned_fix: 'price_not_updated' } })).statusCode).toBe(400);
    const t = (await app.inject({ method: 'GET', url: `/admin/tickets/${id}`, headers: auth(admin) })).json();
    expect(Date.parse(t.sla_due_at) - Date.parse(t.created_at)).toBe(4 * 3_600_000);
  });

  it('another store can’t read it', async () => {
    const b = await createTenant(db, 'Other', '201-555-2071');
    const other = await merchantLogin(app, b.owner_phone);
    const id = (await app.inject({ method: 'GET', url: '/merchant/tickets', headers: auth(owner) })).json().tickets[0].ticket_id;
    expect((await app.inject({ method: 'GET', url: `/merchant/tickets/${id}`, headers: auth(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/merchant/tickets/${id}/notes`, headers: auth(other), payload: { body: 'x' } })).statusCode).toBe(404);
  });
});

describe('hardware', () => {
  it('stock → installed → swapped (old to RMA, new in its place) → repaired back to stock, all in the history', async () => {
    const add = async (serial: string) => (await app.inject({ method: 'POST', url: '/admin/hardware', headers: auth(admin), payload: { kind: 'printer', model: 'Sunmi 80mm', serial, warranty_until: '2027-09-01' } })).json().unit_id as string;
    const p1 = await add('SN-P-0001');
    const p2 = await add('SN-P-0002');
    expect((await app.inject({ method: 'POST', url: `/admin/hardware/${p1}/install`, headers: auth(admin), payload: { register_id: a.register_id } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/merchant/hardware', headers: auth(owner) })).json().units.map((u: { serial: string }) => u.serial)).toEqual(['SN-P-0001']);
    const swap = await app.inject({ method: 'POST', url: `/admin/hardware/${p1}/swap`, headers: auth(admin), payload: { new_unit_id: p2, reason: 'Cutter jams' } });
    expect(swap.json()).toEqual({ rma: p1, installed: p2 });
    const units = (await app.inject({ method: 'GET', url: '/admin/hardware', headers: auth(admin) })).json().units;
    expect(units.find((u: { unit_id: string }) => u.unit_id === p1)).toMatchObject({ status: 'rma', merchant_id: null });
    expect(units.find((u: { unit_id: string }) => u.unit_id === p2)).toMatchObject({ status: 'installed', register_name: 'Register 1' });
    await app.inject({ method: 'POST', url: `/admin/hardware/${p1}/rma-close`, headers: auth(admin), payload: { outcome: 'repaired' } });
    const history = (await app.inject({ method: 'GET', url: `/admin/hardware/${p1}/history`, headers: auth(admin) })).json().events.map((e: { kind: string }) => e.kind);
    expect(history).toEqual(['added', 'installed', 'removed', 'rma_opened', 'rma_closed']);
    expect((await app.inject({ method: 'POST', url: '/admin/hardware', headers: auth(admin), payload: { kind: 'printer', model: 'x', serial: 'SN-P-0001' } })).statusCode).toBe(409);
  });
});
