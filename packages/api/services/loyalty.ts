/**
 * Loyalty, the customer list and promotional texts (P19a, ADR 0029).
 *
 * Balances are folded from the customer's sales on read (never stored). A phone number reaches the
 * server only with an opt-in to texts, and only if it hashes to the ref the register sent. Promos go
 * to opted-in customers through `MessageSender`, at most one per customer a week, always with STOP.
 */
import {
  customerRef,
  foldSale,
  LoyaltySettingsInput,
  loyaltyStatus,
  normalizeUsPhone,
  RegisterEventSchema,
  TEXT_CONSENT_VERSION,
  textConsent,
  type LoyaltySettings,
  type LoyaltyStatus,
  type RegisterEvent,
} from '@adpay/shared';
import { createHash } from 'node:crypto';
import type { AdminPrincipal, DevicePrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { maskRecipient, type MessageSender } from '../messaging/sender';
import { audit } from './audit';

export function loyaltySettingsOf(raw: unknown): LoyaltySettings {
  const parsed = LoyaltySettingsInput.safeParse(raw ?? {});
  return parsed.success ? parsed.data : LoyaltySettingsInput.parse({});
}

export async function loyaltyConfig(q: Queryable, merchantId: string): Promise<{ settings: LoyaltySettings; salt: string; merchant_name: string }> {
  const { rows } = await q.query<{ loyalty_settings: unknown; loyalty_salt: string; name: string }>('SELECT loyalty_settings, loyalty_salt, name FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  return { settings: loyaltySettingsOf(rows[0].loyalty_settings), salt: rows[0].loyalty_salt, merchant_name: rows[0].name };
}

export async function setLoyaltySettings(db: Db, actor: MerchantUserPrincipal | AdminPrincipal, merchantId: string, settings: LoyaltySettings, traceId: string): Promise<LoyaltySettings> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; loyalty_settings: unknown }>('SELECT org_id, loyalty_settings FROM merchants WHERE merchant_id = $1 FOR UPDATE', [merchantId]);
    if (!rows[0]) throw notFound('Merchant not found');
    if (settings.qualifying_category_id) {
      const { rows: cat } = await q.query('SELECT 1 FROM categories WHERE category_id = $1 AND merchant_id = $2', [settings.qualifying_category_id, merchantId]);
      if (!cat[0]) throw badRequest('That category isn’t in this catalog');
    }
    await q.query('UPDATE merchants SET loyalty_settings = $2, catalog_version = catalog_version + 1 WHERE merchant_id = $1', [merchantId, JSON.stringify(settings)]);
    await audit(q, { actor, action: 'loyalty.settings_set', tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: merchantId, details: { from: rows[0].loyalty_settings, to: settings }, trace_id: traceId });
    return settings;
  });
}

/** Keep the customer list current as sales arrive: ref, last four, first and last seen. */
export async function upsertCustomersFromEvents(q: Queryable, events: readonly RegisterEvent[]): Promise<void> {
  const byRef = new Map<string, { org_id: string; merchant_id: string; ref: string; last4: string; first: string; last: string }>();
  for (const e of events) {
    if (e.type !== 'sale.customer_identified') continue;
    const k = `${e.merchant_id}:${e.payload.customer_ref}`;
    const cur = byRef.get(k);
    if (!cur) byRef.set(k, { org_id: e.org_id, merchant_id: e.merchant_id, ref: e.payload.customer_ref, last4: e.payload.last4, first: e.occurred_at, last: e.occurred_at });
    else {
      if (e.occurred_at < cur.first) cur.first = e.occurred_at;
      if (e.occurred_at > cur.last) cur.last = e.occurred_at;
    }
  }
  if (byRef.size === 0) return;
  await q.query(
    `INSERT INTO customers (org_id, merchant_id, customer_ref, last4, first_seen_at, last_seen_at)
     SELECT x.org_id, x.merchant_id, x.ref, x.last4, x.first, x.last
       FROM jsonb_to_recordset($1::jsonb) AS x(org_id uuid, merchant_id uuid, ref text, last4 text, first timestamptz, last timestamptz)
     ON CONFLICT (merchant_id, customer_ref) DO UPDATE
       SET first_seen_at = LEAST(customers.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(customers.last_seen_at, EXCLUDED.last_seen_at)`,
    [JSON.stringify([...byRef.values()])],
  );
}

/** A customer's sales, folded, oldest first. */
async function customerSales(q: Queryable, merchantId: string, ref: string) {
  const { rows } = await q.query<Record<string, unknown> & { occurred_at: Date }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id, e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload
       FROM sale_events e
      WHERE e.merchant_id = $1
        AND e.sale_id IN (SELECT x.sale_id FROM sale_events x
                           WHERE x.type IN ('sale.customer_identified', 'sale.loyalty_redeemed') AND x.payload->>'customer_ref' = $2 AND x.merchant_id = $1)
      ORDER BY e.sale_id, e.device_seq`,
    [merchantId, ref],
  );
  const bySale = new Map<string, RegisterEvent[]>();
  for (const r of rows) {
    const e = RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() });
    bySale.set(e.sale_id!, [...(bySale.get(e.sale_id!) ?? []), e]);
  }
  return [...bySale.entries()]
    .map(([id, events]) => ({ ...foldSale(id, events), occurred_at: events.find((e) => e.type === 'sale.completed')?.occurred_at ?? events[0]!.occurred_at }))
    // Only sales that were really this customer's (the ticket may have been re-identified).
    .filter((s) => s.customer?.ref === ref)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

export async function customerStatus(q: Queryable, merchantId: string, ref: string): Promise<LoyaltyStatus & { enabled: boolean }> {
  const { settings } = await loyaltyConfig(q, merchantId);
  return { ...loyaltyStatus(settings, await customerSales(q, merchantId, ref)), enabled: settings.enabled };
}

/**
 * The customer ticked "text me deals" on the customer screen. The number is accepted only if it
 * hashes to the ref the register computed; the exact consent text is stored with it.
 */
export async function recordOptIn(db: Db, device: DevicePrincipal, body: { phone: string; customer_ref: string; consent_version: string }, traceId: string): Promise<{ ok: true }> {
  const phone = normalizeUsPhone(body.phone);
  if (!phone) throw badRequest('That isn’t a US mobile number');
  if (body.consent_version !== TEXT_CONSENT_VERSION) throw badRequest('Unknown consent text');
  await db.tx(async (q) => {
    const { salt, merchant_name } = await loyaltyConfig(q, device.merchant_id);
    if (customerRef(salt, phone) !== body.customer_ref) throw badRequest('That number doesn’t match the customer on the ticket');
    await q.query(
      `INSERT INTO customers (org_id, merchant_id, customer_ref, last4, first_seen_at, last_seen_at, phone_e164, marketing_opt_in_at, consent_version, consent_text, opt_in_register_id)
       VALUES ($1, $2, $3, $4, now(), now(), $5, now(), $6, $7, $8)
       ON CONFLICT (merchant_id, customer_ref) DO UPDATE
         SET phone_e164 = EXCLUDED.phone_e164, marketing_opt_in_at = now(), consent_version = EXCLUDED.consent_version,
             consent_text = EXCLUDED.consent_text, opt_in_register_id = EXCLUDED.opt_in_register_id, opted_out_at = NULL, opt_out_source = NULL`,
      [device.org_id, device.merchant_id, body.customer_ref, phone.slice(-4), phone, TEXT_CONSENT_VERSION, textConsent(merchant_name), device.register_id],
    );
    await audit(q, {
      actor: device,
      action: 'customer.opted_in',
      tenancy: device,
      target: body.customer_ref,
      details: { last4: phone.slice(-4), consent_version: TEXT_CONSENT_VERSION },
      trace_id: traceId,
    });
  });
  return { ok: true };
}

export interface CustomerRow {
  customer_ref: string;
  last4: string;
  visits: number;
  spent_cents: number;
  last_visit: string | null;
  first_seen: string;
  texts: 'opted_in' | 'opted_out' | 'no';
}

/** Regulars first: by spend. Voided sales don't count. */
export async function customerList(q: Queryable, merchantId: string, limit = 200): Promise<CustomerRow[]> {
  const { rows } = await q.query<{
    customer_ref: string; last4: string; visits: number; spent_cents: number; last_visit: Date | null; first_seen_at: Date;
    phone: boolean; opted_out_at: Date | null;
  }>(
    `WITH tagged AS (
       SELECT DISTINCT ON (sale_id) sale_id, payload->>'customer_ref' AS ref
         FROM sale_events WHERE merchant_id = $1 AND type = 'sale.customer_identified'
        ORDER BY sale_id, device_seq DESC),
     done AS (
       SELECT c.sale_id, (c.payload->>'total_cents')::int AS total, c.occurred_at
         FROM sale_events c WHERE c.merchant_id = $1 AND c.type = 'sale.completed'
          AND NOT EXISTS (SELECT 1 FROM sale_events v WHERE v.sale_id = c.sale_id AND v.type = 'sale.voided'))
     SELECT cu.customer_ref, cu.last4, count(d.sale_id)::int AS visits, COALESCE(sum(d.total), 0)::int AS spent_cents,
            max(d.occurred_at) AS last_visit, cu.first_seen_at, cu.phone_e164 IS NOT NULL AS phone, cu.opted_out_at
       FROM customers cu
       LEFT JOIN tagged t ON t.ref = cu.customer_ref
       LEFT JOIN done d ON d.sale_id = t.sale_id
      WHERE cu.merchant_id = $1
      GROUP BY cu.customer_ref, cu.last4, cu.first_seen_at, cu.phone_e164, cu.opted_out_at
      ORDER BY spent_cents DESC, visits DESC
      LIMIT $2`,
    [merchantId, limit],
  );
  return rows.map((r) => ({
    customer_ref: r.customer_ref,
    last4: r.last4,
    visits: r.visits,
    spent_cents: r.spent_cents,
    last_visit: r.last_visit ? r.last_visit.toISOString() : null,
    first_seen: r.first_seen_at.toISOString(),
    texts: r.opted_out_at ? 'opted_out' : r.phone ? 'opted_in' : 'no',
  }));
}

/** The merchant records an opt-out ("text STOP" arrives by phone call, in person…): the number is removed. */
export async function optOut(db: Db, actor: MerchantUserPrincipal, ref: string, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>(
      `UPDATE customers SET phone_e164 = NULL, opted_out_at = now(), opt_out_source = 'merchant'
        WHERE merchant_id = $1 AND customer_ref = $2 RETURNING org_id`,
      [actor.merchant_id, ref],
    );
    if (!rows[0]) throw notFound('Customer not found');
    await audit(q, { actor, action: 'customer.opted_out', tenancy: { org_id: rows[0].org_id, merchant_id: actor.merchant_id }, target: ref, details: { source: 'merchant' }, trace_id: traceId });
  });
}

export const PROMO_STOP = ' Reply STOP to opt out.';
const PROMO_EVERY_DAYS = 7;

/**
 * Text a promotion to opted-in customers (top N by spend). Each gets at most one promo a week; the
 * STOP line is always added. With the log sender nothing is delivered and the result says so.
 */
export async function sendPromo(
  db: Db,
  sender: MessageSender,
  actor: MerchantUserPrincipal,
  body: { message: string; top: number },
  traceId: string,
): Promise<{ recipients: number; skipped_recent: number; status: 'sent' | 'logged' | 'failed' | 'none'; delivered: boolean }> {
  const { merchant_name } = await loyaltyConfig(db, actor.merchant_id);
  const text = `${merchant_name}: ${body.message.trim()}${PROMO_STOP}`;
  if (text.length > 320) throw badRequest('Keep it under two texts (about 260 characters)');
  const top = new Set((await customerList(db, actor.merchant_id, body.top)).map((c) => c.customer_ref));
  const { rows } = await db.query<{ org_id: string; customer_ref: string; phone_e164: string }>(
    `SELECT org_id, customer_ref, phone_e164 FROM customers WHERE merchant_id = $1 AND phone_e164 IS NOT NULL AND opted_out_at IS NULL`,
    [actor.merchant_id],
  );
  const audience = rows.filter((r) => top.has(r.customer_ref));
  const hash = (to: string) => createHash('sha256').update(`${actor.merchant_id}:${to}`).digest('hex');
  const { rows: recent } = await db.query<{ to_hash: string }>(
    `SELECT DISTINCT to_hash FROM outbound_messages WHERE merchant_id = $1 AND purpose = 'promo' AND created_at > now() - make_interval(days => $2)`,
    [actor.merchant_id, PROMO_EVERY_DAYS],
  );
  const skip = new Set(recent.map((r) => r.to_hash));
  let status: 'sent' | 'logged' | 'failed' | 'none' = 'none';
  let recipients = 0;
  let skipped = 0;
  for (const c of audience) {
    if (skip.has(hash(c.phone_e164))) {
      skipped++;
      continue;
    }
    const r = await sender.send({ channel: 'sms', to: c.phone_e164, subject: null, body: text });
    status = r.status;
    recipients++;
    await db.query(
      `INSERT INTO outbound_messages (org_id, merchant_id, channel, purpose, to_masked, to_hash, provider, status, provider_ref, error, created_by, trace_id)
       VALUES ($1, $2, 'sms', 'promo', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [c.org_id, actor.merchant_id, maskRecipient(c.phone_e164), hash(c.phone_e164), sender.name, r.status, r.provider_ref, r.error, actor.user_id, traceId],
    );
  }
  await db.tx((q) =>
    audit(q, { actor, action: 'customer.promo_sent', tenancy: { merchant_id: actor.merchant_id }, target: actor.merchant_id, details: { recipients, skipped_recent: skipped, chars: text.length, provider: sender.name }, trace_id: traceId }),
  );
  return { recipients, skipped_recent: skipped, status, delivered: sender.delivers && status === 'sent' };
}
