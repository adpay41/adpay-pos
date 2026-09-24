/**
 * Every log line carries org / merchant / location / register ids plus trace_id (CLAUDE.md).
 *
 * Each request gets a logger bound to exactly those keys — null until authentication fills them —
 * built from the base logger so no key is ever bound twice. Non-request code logs through
 * `systemLogger`, which binds the same keys with trace_id "system".
 */
import { randomUUID } from 'node:crypto';
import { EMPTY_TENANT_CONTEXT, type TenantContext } from '@adpay/shared';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import pino from 'pino';

export interface LogContext extends TenantContext {
  trace_id: string;
}

export function createBaseLogger(level: string): pino.Logger {
  return pino({
    level,
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['req.headers.authorization', '*.password', '*.device_token', '*.setup_code', '*.code'],
      censor: '[redacted]',
    },
  });
}

export function systemLogger(base: pino.Logger): pino.Logger {
  return base.child({ trace_id: 'system', ...EMPTY_TENANT_CONTEXT });
}

const TRACE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Honour an incoming x-trace-id or W3C traceparent; otherwise mint one. */
export function traceIdFrom(headers: FastifyRequest['headers']): string {
  const explicit = headers['x-trace-id'];
  if (typeof explicit === 'string' && TRACE_ID.test(explicit)) return explicit;
  const traceparent = headers.traceparent;
  if (typeof traceparent === 'string') {
    const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(traceparent);
    if (m?.[1]) return m[1];
  }
  return randomUUID().replace(/-/g, '');
}

export function bindRequestLogger(
  base: pino.Logger,
  request: FastifyRequest,
  tenancy: TenantContext = EMPTY_TENANT_CONTEXT,
): void {
  request.logContext = { trace_id: request.logContext?.trace_id ?? traceIdFrom(request.headers), ...tenancy };
  request.log = base.child({ reqId: request.id, ...request.logContext }) as FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyRequest {
    logContext: LogContext;
  }
}
