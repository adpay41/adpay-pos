/**
 * Staff, register PINs, roles and per-action permissions (build plan P3 / F2, Bible 1.8, 2.5).
 *
 * The register verifies PINs **on the device**, so it can sign cashiers in during a 72-hour outage
 * (ADR 0002). Its snapshot therefore carries a PBKDF2 hash per staff member, never the PIN. A 4–6
 * digit PIN is a convenience factor that identifies who is at the counter. It is not a strong
 * secret, so the defences are around it: a slow salted hash, per-device lockout after repeated
 * failures, every failure logged as an event, and PINs never shown or sent anywhere after they're set.
 *
 * Sign-in is "tap your name, then PIN", so PINs need not be unique. A uniqueness rule would tell an
 * owner who picked a taken PIN whose PIN it is.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

export const ROLES = ['owner', 'manager', 'cashier'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

/**
 * Actions a role may or may not take. On the register, an action a cashier lacks triggers a manager
 * override (a second PIN) instead of a dead end. In the apps and API it is a plain yes/no.
 */
export const PERMISSIONS = {
  'ticket.void': { label: 'Void an open ticket', where: 'register' },
  'sale.void': { label: 'Void a completed sale', where: 'register' },
  'sale.refund': { label: 'Refund', where: 'register' },
  'line.discount': { label: 'Discount a line', where: 'register' },
  'price.override': { label: 'Change a price at the register', where: 'register' },
  'drawer.no_sale': { label: 'Open the drawer without a sale', where: 'register' },
  'cash.paid_out': { label: 'Pay out / pay in cash', where: 'register' },
  'cash.drop': { label: 'Cash drop to the safe', where: 'register' },
  'item.view_cost': { label: 'See cost and margin', where: 'register' },
  'item.create': { label: 'Add an unknown item at the register', where: 'register' },
  'catalog.edit': { label: 'Edit items and prices', where: 'apps' },
  'reports.view': { label: 'See sales reports', where: 'apps' },
  'staff.manage': { label: 'Manage staff and PINs', where: 'apps' },
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];
export const PermissionSchema = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

/** Defaults. Owners always hold every permission; a merchant can adjust manager and cashier. */
export const DEFAULT_PERMISSIONS: Record<Exclude<Role, 'owner'>, readonly Permission[]> = {
  manager: PERMISSION_KEYS.filter((p) => p !== 'staff.manage'),
  cashier: ['ticket.void', 'cash.drop', 'item.create'],
};

/** Per-merchant overrides over the defaults: `{ cashier: { 'sale.refund': true } }`. */
export const PermissionOverridesSchema = z.strictObject({
  manager: z.partialRecord(PermissionSchema, z.boolean()).optional(),
  cashier: z.partialRecord(PermissionSchema, z.boolean()).optional(),
});
export type PermissionOverrides = z.infer<typeof PermissionOverridesSchema>;

export function permissionsFor(role: Role, overrides: PermissionOverrides = {}): Permission[] {
  if (role === 'owner') return [...PERMISSION_KEYS];
  const set = new Set<Permission>(DEFAULT_PERMISSIONS[role]);
  for (const [p, allowed] of Object.entries(overrides[role] ?? {}) as [Permission, boolean][]) {
    if (allowed) set.add(p);
    else set.delete(p);
  }
  return PERMISSION_KEYS.filter((p) => set.has(p));
}

export function can(role: Role, permission: Permission, overrides: PermissionOverrides = {}): boolean {
  return permissionsFor(role, overrides).includes(permission);
}

// ─────────────────────────────────────────────────────────── PINs ──

/** 4–6 digits, not all the same digit and not a straight run (1234, 9876). */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'A PIN is 4 to 6 digits';
  if (/^(\d)\1+$/.test(pin)) return 'Pick a PIN that isn’t one digit repeated';
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Pick a PIN that isn’t a straight run like 1234';
  return null;
}

export const PinSchema = z.string().superRefine((pin, ctx) => {
  const problem = pinProblem(pin);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** PBKDF2 iterations for new PINs; the count is stored in each hash, so it can change later. */
export const PIN_HASH_ITERATIONS = 10_000;

/** `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>`. Server-side only (needs a random salt). */
export function hashPin(pin: string, iterations = PIN_HASH_ITERATIONS): string {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const key = pbkdf2(sha256, pin, salt, { c: iterations, dkLen: 32 });
  return ['pbkdf2-sha256', iterations, bytesToHex(salt), bytesToHex(key)].join('$');
}

/** Constant-time check of a typed PIN against a stored hash. Runs on the register, offline. */
export function verifyPin(pin: string, encoded: string): boolean {
  const [alg, iter, saltHex, keyHex] = encoded.split('$');
  const c = Number(iter);
  if (alg !== 'pbkdf2-sha256' || !Number.isInteger(c) || c < 1000 || c > 1_000_000 || !saltHex || !keyHex) return false;
  const expected = hexToBytes(keyHex);
  const actual = pbkdf2(sha256, pin, hexToBytes(saltHex), { c, dkLen: expected.length });
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (actual[i] ?? 0) ^ expected[i]!;
  return diff === 0;
}

/** Failed PIN attempts per person per register before that person is locked out on it. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────── wire shapes ──

/** One person who can sign in at a register (device snapshot only; never sent to the apps). */
export interface RegisterStaffMember {
  user_id: string;
  name: string;
  role: Role;
  pin_hash: string;
  permissions: Permission[];
}

/** Staff section of a register's config snapshot. */
export interface RegisterStaff {
  members: RegisterStaffMember[];
}

/** A staff member as the merchant app and admin see them. */
export interface StaffMember {
  user_id: string;
  name: string;
  role: Role;
  phone: string | null;
  has_pin: boolean;
  pin_set_at: string | null;
  disabled: boolean;
  /** Can sign into the merchant app (has a phone number). */
  app_access: boolean;
}

export interface MembershipSummary {
  merchant_id: string;
  merchant_name: string;
  role: Role;
}

const Phone = z.string().trim().regex(/^[+\d\s().-]{10,20}$/, 'Enter a 10-digit phone number');

export const StaffCreateInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  role: RoleSchema,
  /** Optional: only people who use the merchant app need a phone. */
  phone: Phone.nullable().default(null),
  pin: PinSchema.nullable().default(null),
});
export type StaffCreate = z.infer<typeof StaffCreateInput>;

export const StaffUpdateInput = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const PinSetInput = z.strictObject({ pin: PinSchema });
