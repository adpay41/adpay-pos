/**
 * Authentication and multi-tenant guards. Every non-public route declares which principal kinds
 * may call it; the principal's tenancy is bound to the request logger as soon as it is known.
 */
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
import { bindRequestLogger } from './context';
import { forbidden, unauthorized } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function makeAuthenticate(db: Db, config: Config, baseLogger: pino.Logger) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    request.principal = null;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice('Bearer '.length).trim();
    const principal = token.startsWith('dev_')
      ? await resolveDeviceToken(db, token)
      : await verifyUserToken(token, config.jwtSecret, config.jwtIssuer);
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
