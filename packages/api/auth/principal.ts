/**
 * Who is calling. Three kinds, per the spec: AD Pay admin users, merchant users, and registers
 * (device tokens). Tenancy for merchant users and devices comes from the credential — never from
 * the request body or URL — so a caller cannot widen its own scope.
 */
import type { TenantContext } from '@adpay/shared';
import { EMPTY_TENANT_CONTEXT } from '@adpay/shared';
import { jwtVerify, SignJWT } from 'jose';
import type { Queryable } from '../db/db';
import { sha256 } from './crypto';

export interface AdminPrincipal {
  kind: 'admin';
  user_id: string;
  role: 'platform_admin';
}

export interface MerchantUserPrincipal {
  kind: 'merchant_user';
  user_id: string;
  role: 'owner' | 'manager' | 'cashier';
  org_id: string;
  merchant_id: string;
}

export interface DevicePrincipal {
  kind: 'device';
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
}

export type Principal = AdminPrincipal | MerchantUserPrincipal | DevicePrincipal;

export function tenancyOf(p: Principal): TenantContext {
  switch (p.kind) {
    case 'admin':
      return EMPTY_TENANT_CONTEXT;
    case 'merchant_user':
      return { org_id: p.org_id, merchant_id: p.merchant_id, location_id: null, register_id: null };
    case 'device':
      return { org_id: p.org_id, merchant_id: p.merchant_id, location_id: p.location_id, register_id: p.register_id };
  }
}

const USER_TOKEN_TTL = '12h';

export async function signUserToken(
  p: AdminPrincipal | MerchantUserPrincipal,
  secret: string,
  issuer: string,
): Promise<string> {
  const claims =
    p.kind === 'admin'
      ? { kind: p.kind, role: p.role }
      : { kind: p.kind, role: p.role, org_id: p.org_id, merchant_id: p.merchant_id };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.user_id)
    .setIssuer(issuer)
    .setAudience('adpay-api')
    .setIssuedAt()
    .setExpirationTime(USER_TOKEN_TTL)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyUserToken(
  token: string,
  secret: string,
  issuer: string,
): Promise<AdminPrincipal | MerchantUserPrincipal | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer,
      audience: 'adpay-api',
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    if (payload.kind === 'admin' && payload.role === 'platform_admin') {
      return { kind: 'admin', user_id: payload.sub, role: 'platform_admin' };
    }
    if (
      payload.kind === 'merchant_user' &&
      typeof payload.org_id === 'string' &&
      typeof payload.merchant_id === 'string' &&
      (payload.role === 'owner' || payload.role === 'manager' || payload.role === 'cashier')
    ) {
      return {
        kind: 'merchant_user',
        user_id: payload.sub,
        role: payload.role,
        org_id: payload.org_id,
        merchant_id: payload.merchant_id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveDeviceToken(q: Queryable, token: string): Promise<DevicePrincipal | null> {
  const { rows } = await q.query<Omit<DevicePrincipal, 'kind'>>(
    `UPDATE device_tokens t SET last_used_at = now()
       FROM registers r
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
        AND r.register_id = t.register_id AND r.status = 'active'
      RETURNING t.org_id, t.merchant_id, t.location_id, t.register_id`,
    [sha256(token)],
  );
  const row = rows[0];
  return row ? { kind: 'device', ...row } : null;
}
