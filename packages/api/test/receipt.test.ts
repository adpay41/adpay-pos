/**
 * Phase 8 API: per-location receipt settings — saved, validated, carried to the register, and
 * scoped to the merchant. Real Postgres in CI.
 */
import { DEFAULT_RECEIPT_SETTINGS, type CatalogSnapshot } from '@adpay/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { auth, createTenant, createTestApp, createTestDb, merchantLogin, pairDevice, type Tenant } from './helpers';

let db: Db;
let app: FastifyInstance;
let a: Tenant;
let b: Tenant;
let ownerA: string;
let ownerB: string;
let deviceA: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await createTestApp(db);
  a = await createTenant(db, 'Alpha', '201-555-0100');
  b = await createTenant(db, 'Bravo', '718-555-0142');
  ownerA = await merchantLogin(app, a.owner_phone);
  ownerB = await merchantLogin(app, b.owner_phone);
  deviceA = await pairDevice(app, db, a.register_id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const snapshot = async (): Promise<CatalogSnapshot> => (await app.inject({ method: 'GET', url: '/device/catalog', headers: auth(deviceA) })).json();
const put = (token: string, locationId: string, body: object) =>
  app.inject({ method: 'PUT', url: `/merchant/locations/${locationId}/receipt`, headers: auth(token), payload: body });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('logo')]);

describe('receipt settings', () => {
  it('defaults until set; saved settings reach the register with the logo resolved, and bump the catalog', async () => {
    expect((await snapshot()).receipt).toMatchObject({ ...DEFAULT_RECEIPT_SETTINGS, logo_url: null });

    const logo = (await app.inject({ method: 'POST', url: '/merchant/media', headers: { ...auth(ownerA), 'content-type': 'image/jpeg' }, payload: JPEG })).json();
    const v = (await snapshot()).catalog_version;
    const body = {
      header_lines: ['(201) 555-0100'],
      logo_media_id: logo.media_id,
      return_policy: 'No returns on lottery.',
      footer: 'See you tomorrow!',
      qr: { kind: 'link', url: 'https://g.page/r/example/review', caption: 'Rate us' },
      after_sale: 'none',
    };
    const r = await put(ownerA, a.location_id, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().catalog_version).toBe(v + 1);

    const snap = await snapshot();
    expect(snap.receipt).toMatchObject({ ...body, logo_url: `/media/${logo.media_id}` });
    const got = (await app.inject({ method: 'GET', url: `/merchant/locations/${a.location_id}/receipt`, headers: auth(ownerA) })).json();
    expect(got.after_sale).toBe('none');
  });

  it('validates: a bad QR link, a fifth header line, an unknown after-sale choice are refused', async () => {
    for (const bad of [{ qr: { kind: 'link', url: 'not a url', caption: 'x' } }, { header_lines: ['1', '2', '3', '4', '5'] }, { after_sale: 'sometimes' }]) {
      expect((await put(ownerA, a.location_id, bad)).statusCode).toBe(400);
    }
  });

  it("stays inside the merchant: another merchant's logo or location is refused", async () => {
    const theirs = (await app.inject({ method: 'POST', url: '/merchant/media', headers: { ...auth(ownerB), 'content-type': 'image/jpeg' }, payload: Buffer.concat([JPEG, Buffer.from('b')]) })).json();
    expect((await put(ownerA, a.location_id, { logo_media_id: theirs.media_id })).statusCode).toBe(400);
    expect((await put(ownerA, b.location_id, {})).statusCode).toBe(404);
  });
});
