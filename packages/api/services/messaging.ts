/**
 * Send a receipt later, by text or email, from the merchant app (Bible 1.6, P18b, ADR 0028).
 *
 * The message carries the digital-receipt link (ADR 0027): the sale's own token, or a link minted
 * beside the sale when it was rung without one. Delivery goes through `MessageSender`; with the
 * local `log` sender nothing is delivered and the caller is told so.
 */
import { createHash } from 'node:crypto';
import { cents, formatUsd } from '@adpay/shared';
import type { MerchantUserPrincipal } from '../auth/principal';
import type { Db } from '../db/db';
import { badRequest, notFound, tooMany } from '../http/errors';
import { maskRecipient, type Channel, type MessageSender } from '../messaging/sender';
import { audit } from './audit';

const MAX_PER_SALE_PER_HOUR = 5;

export interface SendReceiptInput {
  channel: Channel;
  to: string;
}

/** US phone to +1XXXXXXXXXX, or a trimmed lower-case email; null when it isn't one. */
export function normalizeRecipient(channel: Channel, raw: string): string | null {
  if (channel === 'sms') {
    const d = raw.replace(/\D/g, '');
    const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
  }
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200 ? e : null;
}

export async function sendReceipt(
  db: Db,
  sender: MessageSender,
  actor: MerchantUserPrincipal,
  saleId: string,
  input: SendReceiptInput,
  publicBaseUrl: string,
  traceId: string,
): Promise<{ status: 'sent' | 'logged' | 'failed'; delivered: boolean; to: string; url: string }> {
  const to = normalizeRecipient(input.channel, input.to);
  if (!to) throw badRequest(input.channel === 'sms' ? 'That isn’t a US mobile number' : 'That isn’t an email address');

  const prep = await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; location_id: string; merchant_name: string; token: string | null; total_cents: number | null; completed: boolean }>(
      `SELECT e.org_id, e.location_id, m.name AS merchant_name,
              (SELECT c.payload->>'receipt_token' FROM sale_events c WHERE c.sale_id = e.sale_id AND c.type = 'sale.completed' LIMIT 1) AS token,
              (SELECT (c.payload->>'total_cents')::int FROM sale_events c WHERE c.sale_id = e.sale_id AND c.type = 'sale.completed' LIMIT 1) AS total_cents,
              EXISTS (SELECT 1 FROM sale_events c WHERE c.sale_id = e.sale_id AND c.type = 'sale.completed') AS completed
         FROM sale_events e JOIN merchants m ON m.merchant_id = e.merchant_id
        WHERE e.sale_id = $1 AND e.merchant_id = $2 LIMIT 1`,
      [saleId, actor.merchant_id],
    );
    const sale = rows[0];
    if (!sale) throw notFound('Sale not found');
    if (!sale.completed) throw badRequest('Only a completed sale has a receipt to send');
    const { rows: recent } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbound_messages WHERE sale_id = $1 AND created_at > now() - interval '1 hour'`,
      [saleId],
    );
    if ((recent[0]?.n ?? 0) >= MAX_PER_SALE_PER_HOUR) throw tooMany('That receipt was sent several times this hour; try again later');
    let token = sale.token;
    if (!token) {
      const { rows: link } = await q.query<{ token: string }>(
        `INSERT INTO receipt_links (org_id, merchant_id, sale_id) VALUES ($1, $2, $3)
         ON CONFLICT (sale_id) DO UPDATE SET sale_id = EXCLUDED.sale_id RETURNING token`,
        [sale.org_id, actor.merchant_id, saleId],
      );
      token = link[0]!.token;
    }
    return { ...sale, token };
  });

  const url = `${publicBaseUrl.replace(/\/$/, '')}/r/${prep.token}`;
  const total = prep.total_cents !== null ? ` ${formatUsd(cents(prep.total_cents))}` : '';
  const result = await sender.send({
    channel: input.channel,
    to,
    subject: input.channel === 'email' ? `Your receipt from ${prep.merchant_name}` : null,
    body: `Your receipt from ${prep.merchant_name}${total}: ${url}`,
  });

  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO outbound_messages (org_id, merchant_id, location_id, channel, purpose, to_masked, to_hash, sale_id, provider, status, provider_ref, error, created_by, trace_id)
       VALUES ($1, $2, $3, $4, 'receipt', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        prep.org_id, actor.merchant_id, prep.location_id, input.channel, maskRecipient(to),
        createHash('sha256').update(`${actor.merchant_id}:${to}`).digest('hex'), saleId, sender.name,
        result.status, result.provider_ref, result.error, actor.user_id, traceId,
      ],
    );
    await audit(q, {
      actor,
      action: 'receipt.sent',
      tenancy: { org_id: prep.org_id, merchant_id: actor.merchant_id, location_id: prep.location_id },
      target: saleId,
      details: { channel: input.channel, to: maskRecipient(to), status: result.status, provider: sender.name },
      trace_id: traceId,
    });
  });
  return { status: result.status, delivered: sender.delivers && result.status === 'sent', to: maskRecipient(to), url };
}
