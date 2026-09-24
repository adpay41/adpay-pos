/**
 * Authentication and multi-tenant guards. Every non-public route declares which principal kinds
 * may call it; the principal's tenancy is bound to the request logger as soon as it is known.
 */
import type { Permission } from '@adpay/shared';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pino from 'pino';
import {
  resolveDeviceToken,
  tenancyOf,
  verifyUserToken,
  type AdminPrincipal,
  type DevicePrincipal,
  type MerchantUserPrincipal,
  type Principal,
} from '../auth/principal';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { resolveMembership } from '../services/staff';
import { bindRequestLogger } from './context';
import { forbidden, unauthorized } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Any bearer credential → the principal it proves, or null. Shared by HTTP and the WebSocket. */
export async function resolvePrincipal(db: Db, config: Config, token: string): Promise<Principal | null> {
  const verified = token.startsWith('dev_') ? await resolveDeviceToken(db, token) : await verifyUserToken(token, config.jwtSecret, config.jwtIssuer);
  if (!verified) return null;
  if (verified.kind !== 'merchant_user') return verified;
  // Current role and permissions from the membership, so a change or a removal is immediate.
  const m = await resolveMembership(db, verified.user_id, verified.merchant_id);
  return m ? { ...verified, ...m } : null;
}

export function makeAuthenticate(db: Db, config: Config, baseLogger: pino.Logger) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    request.principal = null;
    if (!header?.startsWith('Bearer ')) return;
    const principal = await resolvePrincipal(db, config, header.slice('Bearer '.length).trim());
    if (!principal) return;
    request.principal = principal;
    bindRequestLogger(baseLogger, request, tenancyOf(principal));
  };
}

function requireKind<K extends Principal['kind']>(...kinds: K[]): preHandlerAsyncHookHandler {
  return async function guard(request: FastifyRequest, _reply: FastifyReply) {
    const p = request.principal;
    if (!p) throw unauthorized();
    if (!(kinds as string[]).includes(p.kind)) throw forbidden();
  };
}

export const requireAdmin = requireKind('admin');
export const requireMerchantUser = requireKind('merchant_user');

/** Guard for merchant-user routes that need one permission (admins pass: they are cross-tenant staff). */
export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async function guard(request: FastifyRequest) {
    const p = request.principal;
    if (!p) throw unauthorized();
    if (p.kind === 'merchant_user' && !p.permissions.includes(permission)) throw forbidden('Your role can’t do that here');
  };
}
export const requireDevice = requireKind('device');

export function asAdmin(r: FastifyRequest): AdminPrincipal {
  if (r.principal?.kind !== 'admin') throw forbidden();
  return r.principal;
}
export function asMerchantUser(r: FastifyRequest): MerchantUserPrincipal {
  if (r.principal?.kind !== 'merchant_user') throw forbidden();
  return r.principal;
}
export function asDevice(r: FastifyRequest): DevicePrincipal {
  if (r.principal?.kind !== 'device') throw forbidden();
  return r.principal;
}
