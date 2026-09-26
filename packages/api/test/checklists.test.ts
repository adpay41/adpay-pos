/**
 * Phase 24c API: opening and closing checklists — the owner's lists reach the register snapshot (with
 * a new catalog version), the register's checklist.completed event is ingested as is, and the report
 * shows each store-day's opening and closing, photos and what was missed. Real Postgres in CI.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_CHECKLISTS } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { ingestEvents } from '../services/events';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let owner: string;
let device: string;
let seq = 1;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Lists', '201-555-2090');
  owner = await merchantLogin(app, a.owner_phone);
  device = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const principal = () => ({ kind: 'device' as const, org_id: a.org_id, merchant_id: a.merchant_id, location_id: a.location_id, register_id: a.register_id });
const ev = (type: string, payload: unknown) => ({
  event_id: randomUUID(),
  schema_version: 1,
  sale_id: null,
  device_seq: seq++,
  occurred_at: new Date().toISOString(),
  org_id: a.org_id,
  merchant_id: a.merchant_id,
  location_id: a.location_id,
  register_id: a.register_id,
  trace_id: 't',
  type,
  payload,
});
const today = () => new Date().toISOString().slice(0, 10);

describe('checklists', () => {
  it('starter lists until the owner writes their own; a change reaches the register snapshot', async () => {
    const first = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    expect(first.checklists).toEqual(DEFAULT_CHECKLISTS);
    expect((await app.inject({ method: 'GET', url: '/merchant/checklists', headers: auth(owner) })).json().custom).toBe(false);

    const lists = { open: [{ id: 'o-1', label: 'Lights on', photo: false }], close: [{ id: 'c-1', label: 'Slicer cleaned', photo: true }, { id: 'c-2', label: 'Back door locked', photo: false }] };
    expect((await app.inject({ method: 'PUT', url: '/merchant/checklists', headers: auth(owner), payload: { ...lists, open: [...lists.open, lists.open[0]] } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/merchant/checklists', headers: auth(owner), payload: lists });
    expect(put.json()).toMatchObject({ custom: true, lists });
    const next = (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(device) })).json();
    expect(next.catalog_version).toBeGreaterThan(first.catalog_version);
    expect(next.checklists).toEqual(lists);
  });

  it('the register records it as ticked; the report shows the day, photos and what was missed', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const photo = (await app.inject({ method: 'POST', url: '/device/media', headers: { ...auth(device), 'content-type': 'image/jpeg' }, payload: jpeg })).json().media_id as string;
    const res = await ingestEvents(db, principal(), [
      ev('checklist.completed', {
        checklist_id: randomUUID(),
        kind: 'close',
        items: [
          { item_id: 'c-1', label: 'Slicer cleaned', photo_required: true, done: true, photo_media_id: photo },
          { item_id: 'c-2', label: 'Back door locked', photo_required: false, done: false, photo_media_id: null },
        ],
        note: 'Lock is sticking',
      }),
    ]);
    expect(res.rejected ?? []).toHaveLength(0);

    const r = (await app.inject({ method: 'GET', url: `/merchant/checklists/report?from=${today()}&to=${today()}`, headers: auth(owner) })).json();
    expect(r.days).toHaveLength(1);
    const day = r.days[0];
    expect(day.open).toBeNull();
    expect(day.close).toMatchObject({ note: 'Lock is sticking', summary: { done: 1, total: 2, missing_photos: 0, complete: false } });
    expect(day.close.items[0].photo_url).toBe(`/media/${photo}`);
  });

  it('a malformed checklist event is refused', async () => {
    const res = await ingestEvents(db, principal(), [ev('checklist.completed', { checklist_id: randomUUID(), kind: 'lunch', items: [], note: null })]);
    expect(res.rejected?.length ?? 0).toBe(1);
  });
});
