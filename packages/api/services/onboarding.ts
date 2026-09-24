/**
 * Merchant onboarding (admin): create org → merchant → location → register, and issue the one-time
 * setup code a register exchanges for its identity. Every write here is audited by the route.
 */
import { PACKS, type PackId, type DeviceIdentity } from '@adpay/shared';
import { hashSetupCode, newDeviceToken, newSetupCode } from '../auth/crypto';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';

export async function createOrg(q: Queryable, name: string): Promise<{ org_id: string }> {
  const { rows } = await q.query<{ org_id: string }>('INSERT INTO orgs (name) VALUES ($1) RETURNING org_id', [name]);
  return rows[0]!;
}

export async function createMerchant(
  q: Queryable,
  input: { org_id: string; name: string; legal_name?: string | null | undefined; enabled_packs?: PackId[] | undefined; seed_pack_categories?: boolean | undefined },
): Promise<{ org_id: string; merchant_id: string }> {
  const packs = input.enabled_packs?.length ? input.enabled_packs : (['cstore'] as PackId[]);
  const { rows } = await q.query<{ org_id: string; merchant_id: string }>(
    `INSERT INTO merchants (org_id, name, legal_name, enabled_packs) VALUES ($1, $2, $3, $4)
     RETURNING org_id, merchant_id`,
    [input.org_id, input.name, input.legal_name ?? null, packs],
  );
  const m = rows[0]!;
  if (input.seed_pack_categories !== false) {
    let sort = 0;
    for (const pack of packs) {
      for (const c of PACKS[pack].defaultCategories) {
        await q.query(
          `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, pack) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [m.org_id, m.merchant_id, c.name, sort++, c.taxable, c.min_age, pack],
        );
      }
    }
  }
  return m;
}

export interface LocationInput {
  merchant_id: string;
  name: string;
  address_line1?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  postal_code?: string | null | undefined;
  timezone?: string | undefined;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

export async function createLocation(q: Queryable, input: LocationInput): Promise<{ org_id: string; merchant_id: string; location_id: string }> {
  const { rows } = await q.query<{ org_id: string; merchant_id: string; location_id: string }>(
    `INSERT INTO locations (org_id, merchant_id, name, address_line1, city, state, postal_code, timezone, tax_rate_ppm, dual_price_rate_ppm)
     SELECT m.org_id, m.merchant_id, $2, $3, $4, $5, $6, $7, $8, $9 FROM merchants m WHERE m.merchant_id = $1
     RETURNING org_id, merchant_id, location_id`,
    [
      input.merchant_id,
      input.name,
      input.address_line1 ?? null,
      input.city ?? null,
      input.state ?? null,
      input.postal_code ?? null,
      input.timezone ?? 'America/New_York',
      input.tax_rate_ppm,
      input.dual_price_rate_ppm,
    ],
  );
  if (!rows[0]) throw notFound('Merchant not found');
  return rows[0];
}

export async function createRegister(
  q: Queryable,
  input: { location_id: string; name: string },
): Promise<{ org_id: string; merchant_id: string; location_id: string; register_id: string }> {
  const { rows } = await q.query<{ org_id: string; merchant_id: string; location_id: string; register_id: string }>(
    `INSERT INTO registers (org_id, merchant_id, location_id, name)
     SELECT l.org_id, l.merchant_id, l.location_id, $2 FROM locations l WHERE l.location_id = $1
     RETURNING org_id, merchant_id, location_id, register_id`,
    [input.location_id, input.name],
  );
  if (!rows[0]) throw notFound('Location not found');
  return rows[0];
}

/** Issue a fresh setup code; any earlier unused code for the register stops working. */
export async function issueSetupCode(
  q: Queryable,
  registerId: string,
  createdBy: string | null,
  ttlHours = 24,
): Promise<{ code: string; expires_at: string }> {
  const { rows } = await q.query<{ org_id: string; merchant_id: string; location_id: string }>(
    `SELECT org_id, merchant_id, location_id FROM registers WHERE register_id = $1 AND status <> 'retired'`,
    [registerId],
  );
  const reg = rows[0];
  if (!reg) throw notFound('Register not found');
  await q.query(
    `UPDATE register_setup_codes SET expires_at = now() WHERE register_id = $1 AND used_at IS NULL AND expires_at > now()`,
    [registerId],
  );
  const { code, hash } = newSetupCode();
  const { rows: ins } = await q.query<{ expires_at: Date }>(
    `INSERT INTO register_setup_codes (code_hash, org_id, merchant_id, location_id, register_id, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7) RETURNING expires_at`,
    [hash, reg.org_id, reg.merchant_id, reg.location_id, registerId, ttlHours, createdBy],
  );
  return { code, expires_at: new Date(ins[0]!.expires_at).toISOString() };
}

export async function deviceIdentity(q: Queryable, registerId: string): Promise<DeviceIdentity> {
  const { rows } = await q.query<DeviceIdentity>(
    `SELECT r.org_id, r.merchant_id, r.location_id, r.register_id, m.name AS merchant_name,
            l.name AS location_name, r.name AS register_name, m.enabled_packs,
            l.address_line1, l.city, l.state, l.postal_code, l.timezone
       FROM registers r JOIN locations l ON l.location_id = r.location_id JOIN merchants m ON m.merchant_id = r.merchant_id
      WHERE r.register_id = $1`,
    [registerId],
  );
  if (!rows[0]) throw notFound('Register not found');
  return rows[0];
}

/**
 * Exchange a setup code for a device token. One use only; pairing again (new code) revokes every
 * earlier token for that register, so a replaced or stolen device stops working.
 */
export async function pairRegister(
  db: Db,
  setupCode: string,
  ttlDays: number,
): Promise<{ device_token: string; identity: DeviceIdentity }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ register_id: string; org_id: string; merchant_id: string; location_id: string }>(
      `UPDATE register_setup_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING register_id, org_id, merchant_id, location_id`,
      [hashSetupCode(setupCode)],
    );
    const code = rows[0];
    if (!code) throw badRequest('That setup code is invalid, used or expired');
    await q.query(`UPDATE device_tokens SET revoked_at = now() WHERE register_id = $1 AND revoked_at IS NULL`, [
      code.register_id,
    ]);
    const { token, hash } = newDeviceToken();
    await q.query(
      `INSERT INTO device_tokens (token_hash, org_id, merchant_id, location_id, register_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [hash, code.org_id, code.merchant_id, code.location_id, code.register_id, ttlDays],
    );
    await q.query(`UPDATE registers SET status = 'active', paired_at = now(), last_seen_at = now() WHERE register_id = $1`, [
      code.register_id,
    ]);
    return { device_token: token, identity: await deviceIdentity(q, code.register_id) };
  });
}

export interface TenancyTree {
  orgs: {
    org_id: string;
    name: string;
    merchants: {
      merchant_id: string;
      name: string;
      enabled_packs: string[];
      catalog_version: number;
      item_count: number;
      locations: {
        location_id: string;
        name: string;
        city: string | null;
        state: string | null;
        tax_rate_ppm: number;
        dual_price_rate_ppm: number;
        registers: { register_id: string; name: string; status: string; paired_at: string | null; last_seen_at: string | null }[];
      }[];
    }[];
  }[];
}

export async function tenancyTree(q: Queryable, merchantId: string | null = null): Promise<TenancyTree> {
  const { rows } = await q.query<{ tree: TenancyTree['orgs'] | null }>(
    `SELECT coalesce(jsonb_agg(o ORDER BY o->>'name'), '[]'::jsonb) AS tree FROM (
       SELECT jsonb_build_object('org_id', org.org_id, 'name', org.name, 'merchants', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'merchant_id', m.merchant_id, 'name', m.name, 'enabled_packs', to_jsonb(m.enabled_packs),
           'catalog_version', m.catalog_version,
           'item_count', (SELECT count(*) FROM items i WHERE i.merchant_id = m.merchant_id),
           'locations', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'location_id', l.location_id, 'name', l.name, 'city', l.city, 'state', l.state,
               'tax_rate_ppm', l.tax_rate_ppm, 'dual_price_rate_ppm', l.dual_price_rate_ppm,
               'registers', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                   'register_id', r.register_id, 'name', r.name, 'status', r.status,
                   'paired_at', r.paired_at, 'last_seen_at', r.last_seen_at) ORDER BY r.name)
                   FROM registers r WHERE r.location_id = l.location_id), '[]'::jsonb)
             ) ORDER BY l.name) FROM locations l WHERE l.merchant_id = m.merchant_id), '[]'::jsonb)
         ) ORDER BY m.name) FROM merchants m
          WHERE m.org_id = org.org_id AND ($1::uuid IS NULL OR m.merchant_id = $1::uuid)), '[]'::jsonb)) AS o
       FROM orgs org
      WHERE $1::uuid IS NULL OR org.org_id = (SELECT org_id FROM merchants WHERE merchant_id = $1::uuid)
     ) t`,
    [merchantId],
  );
  return { orgs: rows[0]?.tree ?? [] };
}
