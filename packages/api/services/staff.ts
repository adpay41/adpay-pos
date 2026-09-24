/**
 * Staff, memberships, register PINs and permissions (build plan P3 / F2).
 *
 * - A person is a `users` row; their role at a merchant is a `memberships` row. Tenancy for every
 *   query comes from the caller's credential or an admin-scoped route, never from the body.
 * - PINs are hashed here (PBKDF2, shared `hashPin`) and only the hash is stored. It goes to that
 *   merchant's registers so they can check PINs offline, and nowhere else: not to the apps, not into
 *   audit details, not into logs.
 * - Every change bumps the merchant's catalog/config version so registers pull the new staff list on
 *   their next sync tick, and is audited.
 * - Guard rails: only owners (or AD Pay admins) create, promote, demote or disable owners, and a
 *   merchant never loses its last active owner.
 */
import {
  PermissionOverridesSchema,
  hashPin,
  permissionsFor,
  type MembershipSummary,
  type Permission,
  type PermissionOverrides,
  type RegisterStaff,
  type Role,
  type StaffCreate,
  type StaffMember,
} from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, forbidden, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';

export type StaffActor = AdminPrincipal | MerchantUserPrincipal;

/** E.164, US only in v1: +1 and ten digits. Accepts common human formatting. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^\d{10}$/.test(ten)) throw badRequest('Enter a 10-digit US phone number');
  return `+1${ten}`;
}

async function merchantRow(q: Queryable, merchantId: string): Promise<{ org_id: string; merchant_id: string; permission_overrides: PermissionOverrides }> {
  const { rows } = await q.query<{ org_id: string; merchant_id: string; permission_overrides: PermissionOverrides }>(
    'SELECT org_id, merchant_id, permission_overrides FROM merchants WHERE merchant_id = $1',
    [merchantId],
  );
  if (!rows[0]) throw notFound('Merchant not found');
  return rows[0];
}

/** Overrides as stored; anything malformed is ignored rather than trusted. */
export async function permissionOverrides(q: Queryable, merchantId: string): Promise<PermissionOverrides> {
  const m = await merchantRow(q, merchantId);
  const parsed = PermissionOverridesSchema.safeParse(m.permission_overrides);
  return parsed.success ? parsed.data : {};
}

interface StaffRow {
  user_id: string;
  name: string;
  phone: string | null;
  role: Role;
  pin_hash: string | null;
  pin_set_at: Date | string | null;
  disabled: boolean;
}

const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

async function staffRows(q: Queryable, merchantId: string, userId?: string): Promise<StaffRow[]> {
  const { rows } = await q.query<StaffRow>(
    `SELECT u.user_id, u.name, u.phone, m.role, m.pin_hash, m.pin_set_at,
            (m.disabled_at IS NOT NULL OR u.disabled_at IS NOT NULL) AS disabled
       FROM memberships m JOIN users u ON u.user_id = m.user_id
      WHERE m.merchant_id = $1 AND ($2::uuid IS NULL OR m.user_id = $2)
      ORDER BY (m.disabled_at IS NOT NULL), CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.name`,
    [merchantId, userId ?? null],
  );
  return rows;
}

const toMember = (r: StaffRow): StaffMember => ({
  user_id: r.user_id,
  name: r.name,
  role: r.role,
  phone: r.phone,
  has_pin: r.pin_hash !== null,
  pin_set_at: iso(r.pin_set_at),
  disabled: r.disabled,
  app_access: r.phone !== null,
});

export async function listStaff(q: Queryable, merchantId: string): Promise<StaffMember[]> {
  await merchantRow(q, merchantId);
  return (await staffRows(q, merchantId)).map(toMember);
}

/** The staff section of a register's snapshot: active people with a PIN, and what each may do. */
export async function registerStaff(q: Queryable, merchantId: string): Promise<RegisterStaff> {
  const overrides = await permissionOverrides(q, merchantId);
  const rows = await staffRows(q, merchantId);
  return {
    members: rows
      .filter((r) => !r.disabled && r.pin_hash)
      .map((r) => ({ user_id: r.user_id, name: r.name, role: r.role, pin_hash: r.pin_hash!, permissions: permissionsFor(r.role, overrides) })),
  };
}

export async function membershipsOf(q: Queryable, userId: string): Promise<MembershipSummary[]> {
  const { rows } = await q.query<MembershipSummary>(
    `SELECT m.merchant_id, mc.name AS merchant_name, m.role
       FROM memberships m JOIN merchants mc ON mc.merchant_id = m.merchant_id JOIN users u ON u.user_id = m.user_id
      WHERE m.user_id = $1 AND m.disabled_at IS NULL AND u.disabled_at IS NULL
      ORDER BY m.created_at, mc.name`,
    [userId],
  );
  return rows;
}

/**
 * Resolve a merchant user's current role and permissions at a merchant, per request, so a role
 * change or a disabled membership takes effect immediately rather than when a token expires.
 */
export async function resolveMembership(
  q: Queryable,
  userId: string,
  merchantId: string,
): Promise<{ org_id: string; role: Role; permissions: Permission[] } | null> {
  const { rows } = await q.query<{ org_id: string; role: Role; permission_overrides: PermissionOverrides }>(
    `SELECT m.org_id, m.role, mc.permission_overrides
       FROM memberships m JOIN users u ON u.user_id = m.user_id JOIN merchants mc ON mc.merchant_id = m.merchant_id
      WHERE m.user_id = $1 AND m.merchant_id = $2 AND m.disabled_at IS NULL AND u.disabled_at IS NULL AND u.kind = 'merchant_user'`,
    [userId, merchantId],
  );
  const r = rows[0];
  if (!r) return null;
  const parsed = PermissionOverridesSchema.safeParse(r.permission_overrides);
  return { org_id: r.org_id, role: r.role, permissions: permissionsFor(r.role, parsed.success ? parsed.data : {}) };
}

// ─────────────────────────────────────────────────────────── writes ──

function assertCanManage(actor: StaffActor, touchesOwner: boolean) {
  if (actor.kind === 'admin') return;
  if (!actor.permissions.includes('staff.manage')) throw forbidden('Only an owner can manage staff');
  if (touchesOwner && actor.role !== 'owner') throw forbidden('Only an owner can add, change or remove an owner');
}

async function activeOwnerCount(q: Queryable, merchantId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.user_id = m.user_id
      WHERE m.merchant_id = $1 AND m.role = 'owner' AND m.disabled_at IS NULL AND u.disabled_at IS NULL`,
    [merchantId],
  );
  return rows[0]!.n;
}

export async function createStaff(
  db: Db,
  actor: StaffActor,
  merchantId: string,
  input: StaffCreate,
  traceId: string,
): Promise<{ user_id: string; catalog_version: number }> {
  assertCanManage(actor, input.role === 'owner');
  const phone = input.phone ? normalizePhone(input.phone) : null;
  return db.tx(async (q) => {
    const m = await merchantRow(q, merchantId);
    let userId: string | null = null;
    if (phone) {
      // Someone who already works at another store keeps one login; they gain a membership here.
      const { rows } = await q.query<{ user_id: string; kind: string }>('SELECT user_id, kind FROM users WHERE phone = $1', [phone]);
      if (rows[0]?.kind === 'admin') throw badRequest('That phone number belongs to an AD Pay staff account');
      userId = rows[0]?.user_id ?? null;
    }
    if (userId) {
      const { rows } = await q.query('SELECT 1 FROM memberships WHERE user_id = $1 AND merchant_id = $2', [userId, merchantId]);
      if (rows[0]) throw badRequest('That person is already on this store’s staff');
    } else {
      const { rows } = await q.query<{ user_id: string }>(
        `INSERT INTO users (kind, name, phone) VALUES ('merchant_user', $1, $2) RETURNING user_id`,
        [input.name, phone],
      );
      userId = rows[0]!.user_id;
    }
    await q.query(
      `INSERT INTO memberships (user_id, org_id, merchant_id, role, pin_hash, pin_set_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)`,
      [userId, m.org_id, merchantId, input.role, input.pin ? hashPin(input.pin) : null],
    );
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'staff.added',
      tenancy: m,
      target: userId,
      details: { name: input.name, role: input.role, app_access: phone !== null, pin_set: input.pin !== null, catalog_version: version },
      trace_id: traceId,
    });
    return { user_id: userId, catalog_version: version };
  });
}

export async function updateStaff(
  db: Db,
  actor: StaffActor,
  merchantId: string,
  userId: string,
  patch: { name?: string | undefined; role?: Role | undefined; disabled?: boolean | undefined },
  traceId: string,
): Promise<{ user_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantRow(q, merchantId);
    const { rows } = await q.query<{ role: Role; disabled: boolean }>(
      'SELECT role, disabled_at IS NOT NULL AS disabled FROM memberships WHERE user_id = $1 AND merchant_id = $2 FOR UPDATE',
      [userId, merchantId],
    );
    const before = rows[0];
    if (!before) throw notFound('Staff member not found');
    const touchesOwner = before.role === 'owner' || patch.role === 'owner';
    assertCanManage(actor, touchesOwner && (patch.role !== undefined || patch.disabled !== undefined));
    if (actor.kind === 'merchant_user' && actor.user_id === userId && patch.disabled) throw badRequest('You can’t disable yourself');

    const losesOwner = before.role === 'owner' && !before.disabled && ((patch.role && patch.role !== 'owner') || patch.disabled === true);
    if (losesOwner && (await activeOwnerCount(q, merchantId)) <= 1) {
      throw badRequest('A store needs at least one active owner. Add another owner first.');
    }

    if (patch.role !== undefined || patch.disabled !== undefined) {
      await q.query(
        `UPDATE memberships SET role = coalesce($3, role),
                disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN coalesce(disabled_at, now()) ELSE NULL END
          WHERE user_id = $1 AND merchant_id = $2`,
        [userId, merchantId, patch.role ?? null, patch.disabled ?? null],
      );
    }
    if (patch.name !== undefined) {
      if (actor.kind === 'merchant_user') {
        // A name is the person's, shared across stores: only rename someone who works only here.
        const { rows: others } = await q.query('SELECT 1 FROM memberships WHERE user_id = $1 AND merchant_id <> $2', [userId, merchantId]);
        if (others[0]) throw badRequest('This person also works at another store; ask AD Pay support to change their name');
      }
      await q.query('UPDATE users SET name = $2 WHERE user_id = $1', [userId, patch.name]);
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'staff.updated',
      tenancy: m,
      target: userId,
      details: { ...patch, role_before: before.role, catalog_version: version },
      trace_id: traceId,
    });
    return { user_id: userId, catalog_version: version };
  });
}

/** Set a register PIN. Anyone may set their own; managing others needs `staff.manage`. */
export async function setPin(
  db: Db,
  actor: StaffActor,
  merchantId: string,
  userId: string,
  pin: string,
  traceId: string,
): Promise<{ user_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const m = await merchantRow(q, merchantId);
    const { rows } = await q.query<{ role: Role }>('SELECT role FROM memberships WHERE user_id = $1 AND merchant_id = $2 FOR UPDATE', [
      userId,
      merchantId,
    ]);
    if (!rows[0]) throw notFound('Staff member not found');
    const self = actor.kind === 'merchant_user' && actor.user_id === userId;
    if (!self) assertCanManage(actor, rows[0].role === 'owner');
    await q.query('UPDATE memberships SET pin_hash = $3, pin_set_at = now() WHERE user_id = $1 AND merchant_id = $2', [
      userId,
      merchantId,
      hashPin(pin),
    ]);
    const version = await bumpCatalogVersion(q, merchantId);
    // Never the PIN or its hash in the audit trail: only that it changed and who changed it.
    await audit(q, { actor, action: 'staff.pin_set', tenancy: m, target: userId, details: { self, catalog_version: version }, trace_id: traceId });
    return { user_id: userId, catalog_version: version };
  });
}

export async function setPermissionOverrides(
  db: Db,
  actor: StaffActor,
  merchantId: string,
  overrides: PermissionOverrides,
  traceId: string,
): Promise<{ overrides: PermissionOverrides; catalog_version: number }> {
  assertCanManage(actor, false);
  return db.tx(async (q) => {
    const m = await merchantRow(q, merchantId);
    await q.query('UPDATE merchants SET permission_overrides = $2 WHERE merchant_id = $1', [merchantId, JSON.stringify(overrides)]);
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'staff.permissions_set',
      tenancy: m,
      details: { from: m.permission_overrides, to: overrides, catalog_version: version },
      trace_id: traceId,
    });
    return { overrides, catalog_version: version };
  });
}
