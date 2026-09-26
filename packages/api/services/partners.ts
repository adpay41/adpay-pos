/**
 * Partner API keys and webhooks (Bible 3.4; P25a, ADR 0039).
 *
 *  - Keys: `adp_<prefix>_<secret>`, shown once; only a SHA-256 of the whole key is stored. A key reads
 *    one merchant's data within its scopes. Revoking is immediate.
 *  - Webhooks: when the register's events land (`ingestEvents`), a delivery row is queued in the same
 *    transaction for every endpoint subscribed to that event type. The maintenance job posts them,
 *    signed (HMAC-SHA256 over `timestamp.body`, Stripe-style), and retries on a fixed schedule.
 *    `WebhookTransport` is the seam: `http` in the server, a recorder in tests.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_KEY_PATTERN,
  nextAttemptAt,
  WEBHOOK_EVENT_KEYS,
  webhookUrlProblem,
  type ApiKeyInput,
  type ApiScope,
  type RegisterEvent,
  type WebhookEndpointInput,
  type WebhookEvent,
} from '@adpay/shared';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';

// ─────────────────────────────────────────────────────────────────────────── keys ──

export interface ApiKeyPrincipal {
  key_id: string;
  org_id: string;
  merchant_id: string;
  scopes: ApiScope[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newPrefix = () => [...randomBytes(8)].map((b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join('');

export interface ApiKeyRow {
  key_id: string;
  merchant_id: string;
  merchant_name: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listApiKeys(q: Queryable, merchantId?: string): Promise<ApiKeyRow[]> {
  const { rows } = await q.query<ApiKeyRow>(
    `SELECT k.key_id, k.merchant_id, m.name AS merchant_name, k.name, k.prefix, k.scopes, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k JOIN merchants m ON m.merchant_id = k.merchant_id
      WHERE ($1::uuid IS NULL OR k.merchant_id = $1)
      ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
    [merchantId ?? null],
  );
  return rows;
}

/** Creates a key and returns it in full — the only time it is ever visible. */
export async function createApiKey(db: Db, actor: AdminPrincipal, input: ApiKeyInput, traceId: string): Promise<{ key_id: string; key: string }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [input.merchant_id]);
    if (!rows[0]) throw notFound('Merchant not found');
    const prefix = newPrefix();
    const key = `adp_${prefix}_${token(32)}`;
    const { rows: k } = await q.query<{ key_id: string }>(
      'INSERT INTO api_keys (org_id, merchant_id, name, prefix, key_hash, scopes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING key_id',
      [rows[0].org_id, input.merchant_id, input.name, prefix, sha256(key), input.scopes, actor.user_id],
    );
    await audit(q, {
      actor,
      action: 'api_key.created',
      tenancy: { org_id: rows[0].org_id, merchant_id: input.merchant_id },
      target: k[0]!.key_id,
      details: { name: input.name, prefix, scopes: input.scopes },
      trace_id: traceId,
    });
    return { key_id: k[0]!.key_id, key };
  });
}

export async function revokeApiKey(db: Db, actor: AdminPrincipal, keyId: string, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; merchant_id: string }>(
      'UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE key_id = $1 AND revoked_at IS NULL RETURNING org_id, merchant_id',
      [keyId, actor.user_id],
    );
    if (!rows[0]) throw notFound('Key not found or already revoked');
    await audit(q, { actor, action: 'api_key.revoked', tenancy: rows[0], target: keyId, trace_id: traceId });
  });
}

/** The key's principal, or null for anything that isn't a live key. Constant-time on the hash. */
export async function resolveApiKey(q: Queryable, raw: string): Promise<ApiKeyPrincipal | null> {
  const m = API_KEY_PATTERN.exec(raw);
  if (!m) return null;
  const { rows } = await q.query<ApiKeyPrincipal & { key_hash: string; last_used_at: Date | null }>(
    'SELECT key_id, org_id, merchant_id, scopes, key_hash, last_used_at FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL',
    [m[1]],
  );
  const k = rows[0];
  if (!k) return null;
  const a = Buffer.from(k.key_hash, 'hex');
  const b = Buffer.from(sha256(raw), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // "Last used" to the minute is enough, and spares a write per request.
  if (!k.last_used_at || Date.now() - k.last_used_at.getTime() > 60_000) await q.query('UPDATE api_keys SET last_used_at = now() WHERE key_id = $1', [k.key_id]);
  return { key_id: k.key_id, org_id: k.org_id, merchant_id: k.merchant_id, scopes: k.scopes };
}

// ─────────────────────────────────────────────────────────────────────── webhooks ──

export interface EndpointRow {
  endpoint_id: string;
  merchant_id: string;
  merchant_name: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  created_at: string;
  disabled_at: string | null;
  delivered: number;
  pending: number;
  failed: number;
}

export async function listEndpoints(q: Queryable): Promise<EndpointRow[]> {
  const { rows } = await q.query<EndpointRow>(
    `SELECT e.endpoint_id, e.merchant_id, m.name AS merchant_name, e.url, e.description, e.events, e.created_at, e.disabled_at,
            count(d.*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
            count(d.*) FILTER (WHERE d.status = 'pending')::int AS pending,
            count(d.*) FILTER (WHERE d.status = 'failed')::int AS failed
       FROM webhook_endpoints e JOIN merchants m ON m.merchant_id = e.merchant_id
       LEFT JOIN webhook_deliveries d ON d.endpoint_id = e.endpoint_id
      GROUP BY e.endpoint_id, m.name
      ORDER BY e.disabled_at NULLS FIRST, e.created_at DESC`,
  );
  return rows;
}

export async function createEndpoint(db: Db, actor: AdminPrincipal, input: WebhookEndpointInput, allowLocal: boolean, traceId: string): Promise<{ endpoint_id: string; secret: string }> {
  const problem = webhookUrlProblem(input.url, allowLocal);
  if (problem) throw badRequest(problem);
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [input.merchant_id]);
    if (!rows[0]) throw notFound('Merchant not found');
    const secret = `whsec_${token(32)}`;
    const { rows: e } = await q.query<{ endpoint_id: string }>(
      'INSERT INTO webhook_endpoints (org_id, merchant_id, url, description, events, secret, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING endpoint_id',
      [rows[0].org_id, input.merchant_id, input.url, input.description, input.events, secret, actor.user_id],
    );
    await audit(q, {
      actor,
      action: 'webhook.created',
      tenancy: { org_id: rows[0].org_id, merchant_id: input.merchant_id },
      target: e[0]!.endpoint_id,
      details: { url: input.url, events: input.events },
      trace_id: traceId,
    });
    return { endpoint_id: e[0]!.endpoint_id, secret };
  });
}

export async function disableEndpoint(db: Db, actor: AdminPrincipal, endpointId: string, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; merchant_id: string }>(
      'UPDATE webhook_endpoints SET disabled_at = now() WHERE endpoint_id = $1 AND disabled_at IS NULL RETURNING org_id, merchant_id',
      [endpointId],
    );
    if (!rows[0]) throw notFound('Endpoint not found or already off');
    // Nothing more goes out to it; pending deliveries are given up.
    await q.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint disabled', next_attempt_at = NULL WHERE endpoint_id = $1 AND status = 'pending'`, [endpointId]);
    await audit(q, { actor, action: 'webhook.disabled', tenancy: rows[0], target: endpointId, trace_id: traceId });
  });
}

export async function rotateEndpointSecret(db: Db, actor: AdminPrincipal, endpointId: string, traceId: string): Promise<{ secret: string }> {
  return db.tx(async (q) => {
    const secret = `whsec_${token(32)}`;
    const { rows } = await q.query<{ org_id: string; merchant_id: string }>('UPDATE webhook_endpoints SET secret = $2 WHERE endpoint_id = $1 RETURNING org_id, merchant_id', [endpointId, secret]);
    if (!rows[0]) throw notFound('Endpoint not found');
    await audit(q, { actor, action: 'webhook.secret_rotated', tenancy: rows[0], target: endpointId, trace_id: traceId });
    return { secret };
  });
}

/**
 * What a partner receives for an event: a stable envelope, integer cents, no card data, no customer
 * data, no receipt link. Only the fields listed here ever leave.
 */
export function webhookBody(e: RegisterEvent): Record<string, unknown> | null {
  const base = { id: e.event_id, type: e.type, created: e.occurred_at, merchant_id: e.merchant_id, location_id: e.location_id, register_id: e.register_id };
  switch (e.type) {
    case 'sale.completed':
      return { ...base, data: { sale_id: e.sale_id, price_mode: e.payload.price_mode, subtotal_cents: e.payload.subtotal_cents, tax_cents: e.payload.tax_cents, total_cents: e.payload.total_cents } };
    case 'sale.refunded':
      return { ...base, data: { sale_id: e.sale_id, refund_id: e.payload.refund_id, tender_type: e.payload.tender_type, amount_cents: e.payload.amount_cents, reason: e.payload.reason } };
    case 'sale.voided':
      return { ...base, data: { sale_id: e.sale_id, reason: e.payload.reason } };
    case 'eod.closed':
      return { ...base, data: { z_number: e.payload.z_number, business_date: e.payload.business_date, totals: e.payload.totals } };
    default:
      return null;
  }
}

/** Queue deliveries for freshly accepted events (called inside the ingest transaction). */
export async function enqueueWebhooks(q: Queryable, events: readonly RegisterEvent[]): Promise<number> {
  const relevant = events.filter((e) => (WEBHOOK_EVENT_KEYS as string[]).includes(e.type));
  if (!relevant.length) return 0;
  const { rows: endpoints } = await q.query<{ endpoint_id: string; events: string[] }>(
    'SELECT endpoint_id, events FROM webhook_endpoints WHERE merchant_id = $1 AND disabled_at IS NULL',
    [relevant[0]!.merchant_id],
  );
  if (!endpoints.length) return 0;
  const rows: { endpoint_id: string; merchant_id: string; event_id: string; event_type: string; body: unknown }[] = [];
  for (const e of relevant) {
    const body = webhookBody(e);
    if (!body) continue;
    for (const ep of endpoints) if (ep.events.includes(e.type)) rows.push({ endpoint_id: ep.endpoint_id, merchant_id: e.merchant_id, event_id: e.event_id, event_type: e.type, body });
  }
  if (!rows.length) return 0;
  await q.query(
    `INSERT INTO webhook_deliveries (endpoint_id, merchant_id, event_id, event_type, body, status, next_attempt_at)
     SELECT x.endpoint_id, x.merchant_id, x.event_id, x.event_type, x.body, 'pending', now()
       FROM jsonb_to_recordset($1::jsonb) AS x(endpoint_id uuid, merchant_id uuid, event_id uuid, event_type text, body jsonb)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return rows.length;
}

export interface WebhookTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }>;
}

export const httpTransport: WebhookTransport = {
  async post(url, headers, body) {
    // No redirects: a 3xx could point the request somewhere the URL check never saw.
    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return { status: res.status };
  },
};

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — verify by recomputing. */
export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Post what's due, one attempt per row per run. Rows are claimed first with a short lease (their next
 * attempt pushed 5 minutes out, SKIP LOCKED), so concurrent runs never double-post and no database
 * transaction stays open while a partner's server is slow.
 */
export async function deliverWebhooks(db: Db, transport: WebhookTransport, now = new Date(), limit = 50): Promise<{ delivered: number; retrying: number; failed: number }> {
  const out = { delivered: 0, retrying: 0, failed: 0 };
  const { rows } = await db.query<{ delivery_id: string; event_id: string; event_type: string; body: unknown; attempts: number; url: string; secret: string }>(
    `WITH due AS (
       SELECT d.delivery_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.endpoint_id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= $1 AND e.disabled_at IS NULL
        ORDER BY d.next_attempt_at
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED)
     UPDATE webhook_deliveries d SET next_attempt_at = $1::timestamptz + interval '5 minutes'
       FROM due, webhook_endpoints e
      WHERE d.delivery_id = due.delivery_id AND e.endpoint_id = d.endpoint_id
      RETURNING d.delivery_id, d.event_id, d.event_type, d.body, d.attempts, e.url, e.secret`,
    [now.toISOString(), limit],
  );
  for (const d of rows) {
    const body = JSON.stringify(d.body);
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = (
        await transport.post(
          d.url,
          { 'content-type': 'application/json', 'user-agent': 'ADPay-Webhooks/1', 'adpay-event-id': d.event_id, 'adpay-delivery-id': d.delivery_id, 'adpay-signature': signWebhook(d.secret, body, now) },
          body,
        )
      ).status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      await db.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_status_code = $3, last_error = NULL, delivered_at = $4, next_attempt_at = NULL WHERE delivery_id = $1`, [
        d.delivery_id,
        attempts,
        status,
        now.toISOString(),
      ]);
      out.delivered++;
      continue;
    }
    const next = nextAttemptAt(attempts, now);
    await db.query(`UPDATE webhook_deliveries SET status = $2, attempts = $3, last_status_code = $4, last_error = $5, next_attempt_at = $6 WHERE delivery_id = $1`, [
      d.delivery_id,
      next ? 'pending' : 'failed',
      attempts,
      status,
      error,
      next?.toISOString() ?? null,
    ]);
    if (next) out.retrying++;
    else out.failed++;
  }
  return out;
}

export async function recentDeliveries(q: Queryable, endpointId: string): Promise<unknown[]> {
  const { rows } = await q.query(
    `SELECT delivery_id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, created_at, delivered_at
       FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [endpointId],
  );
  return rows;
}

/** Send a failed (or pending) delivery again now, from the first attempt's schedule. */
export async function redeliver(db: Db, actor: AdminPrincipal, deliveryId: string, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ merchant_id: string }>(
      `UPDATE webhook_deliveries d SET status = 'pending', attempts = 0, next_attempt_at = now()
        FROM webhook_endpoints e
        WHERE d.delivery_id = $1 AND e.endpoint_id = d.endpoint_id AND e.disabled_at IS NULL AND d.status <> 'delivered'
        RETURNING d.merchant_id`,
      [deliveryId],
    );
    if (!rows[0]) throw badRequest('Only an undelivered delivery on a live endpoint can be sent again');
    await audit(q, { actor, action: 'webhook.redelivered', tenancy: { merchant_id: rows[0].merchant_id }, target: deliveryId, trace_id: traceId });
  });
}

// ──────────────────────────────────────────────────────────────── partner reads ──

export async function partnerSales(q: Queryable, merchantId: string, from: string, to: string): Promise<unknown[]> {
  const { rows } = await q.query(
    `SELECT e.sale_id, e.location_id, e.register_id, e.occurred_at AS completed_at, to_char(e.business_date, 'YYYY-MM-DD') AS business_date,
            e.payload->>'price_mode' AS price_mode, (e.payload->>'subtotal_cents')::bigint AS subtotal_cents,
            (e.payload->>'tax_cents')::bigint AS tax_cents, (e.payload->>'total_cents')::bigint AS total_cents,
            coalesce((SELECT sum((r.payload->>'amount_cents')::bigint) FROM sale_events r WHERE r.sale_id = e.sale_id AND r.type = 'sale.refunded'), 0)::bigint AS refunded_cents,
            EXISTS (SELECT 1 FROM sale_events v WHERE v.sale_id = e.sale_id AND v.type = 'sale.voided') AS voided
       FROM sale_events e
      WHERE e.merchant_id = $1 AND e.type = 'sale.completed' AND e.business_date BETWEEN $2::date AND $3::date
      ORDER BY e.occurred_at
      LIMIT 10000`,
    [merchantId, from, to],
  );
  return rows.map((r) => {
    const x = r as Record<string, unknown>;
    // bigint arrives as a string from pg: back to integer cents (safe: well under 2^53).
    for (const k of ['subtotal_cents', 'tax_cents', 'total_cents', 'refunded_cents']) x[k] = Number(x[k]);
    return x;
  });
}

export async function partnerItems(q: Queryable, merchantId: string): Promise<unknown[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `SELECT i.item_id, i.name, c.name AS category, i.cash_price_cents, i.card_price_cents, i.active,
            coalesce((SELECT array_agg(b.barcode ORDER BY b.barcode) FROM item_barcodes b WHERE b.item_id = i.item_id), '{}') AS barcodes
       FROM items i LEFT JOIN categories c ON c.category_id = i.category_id
      WHERE i.merchant_id = $1
      ORDER BY i.name`,
    [merchantId],
  );
  return rows.map((r) => ({ ...r, cash_price_cents: Number(r.cash_price_cents), card_price_cents: r.card_price_cents === null ? null : Number(r.card_price_cents) }));
}
