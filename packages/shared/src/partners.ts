/**
 * Partner API keys and webhooks (Bible 3.4; P25a, ADR 0039). A merchant's data can be read by a
 * partner (their accountant's tool, a delivery or loyalty app) with an API key scoped to that
 * merchant, and pushed to the partner as signed webhooks. Read-only in v1: nothing a partner sends
 * changes a sale, a price or a setting.
 */
import { z } from 'zod';

export const API_SCOPES = {
  'sales:read': 'Completed sales and refunds (totals, tax, tender; no card data, no customers)',
  'catalog:read': 'Items, prices and barcodes',
  'inventory:read': 'Stock levels',
} as const;
export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_KEYS = Object.keys(API_SCOPES) as ApiScope[];

export const ApiKeyInput = z.strictObject({
  merchant_id: z.uuid(),
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(z.enum(API_SCOPE_KEYS as [ApiScope, ...ApiScope[]]))
    .min(1)
    .refine((s) => new Set(s).size === s.length, 'Each scope once'),
});
export type ApiKeyInput = z.infer<typeof ApiKeyInput>;

/** `adp_<8-char prefix>_<secret>`: the prefix finds the key, only a hash of the whole key is stored. */
export const API_KEY_PATTERN = /^adp_([a-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/;

export const WEBHOOK_EVENTS = {
  'sale.completed': 'A sale was completed',
  'sale.refunded': 'A refund was given',
  'sale.voided': 'A completed sale was voided',
  'eod.closed': 'End of day (Z report) closed',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_KEYS = Object.keys(WEBHOOK_EVENTS) as WebhookEvent[];

export const WebhookEndpointInput = z.strictObject({
  merchant_id: z.uuid(),
  url: z.url().max(500),
  description: z.string().trim().max(120).default(''),
  events: z
    .array(z.enum(WEBHOOK_EVENT_KEYS as [WebhookEvent, ...WebhookEvent[]]))
    .min(1)
    .refine((s) => new Set(s).size === s.length, 'Each event once'),
});
export type WebhookEndpointInput = z.infer<typeof WebhookEndpointInput>;

/** Seconds to wait after each failed attempt; after the last one the delivery is marked failed. */
export const WEBHOOK_RETRY_SECONDS = [60, 300, 1_800, 7_200, 21_600, 43_200] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SECONDS.length + 1;

/** When the next attempt is due after `attempts` failures, or null when it's time to give up. */
export function nextAttemptAt(attempts: number, from: Date): Date | null {
  const wait = WEBHOOK_RETRY_SECONDS[attempts - 1];
  return wait === undefined ? null : new Date(from.getTime() + wait * 1000);
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Where a webhook may point. HTTPS to a public host; plain HTTP only to localhost when `allowLocal`
 * (development). Private and link-local address literals are refused (no reaching into our network).
 * Returns the reason it's refused, or null when it's fine.
 */
export function webhookUrlProblem(raw: string, allowLocal: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a URL';
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.username || u.password) return 'No credentials in the URL; the signature authenticates us';
  if (local) return allowLocal ? null : 'Localhost is only allowed in development';
  if (u.protocol !== 'https:') return 'Webhooks must use https';
  if (PRIVATE_V4.some((r) => r.test(host)) || host.endsWith('.internal') || host.endsWith('.local') || /^(fc|fd|fe80)/.test(host)) return 'Private network addresses are not allowed';
  return null;
}
