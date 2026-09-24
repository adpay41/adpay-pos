/**
 * Card payments for registers (build plan P9, ADR 0003 / 0017). The register sends only an amount
 * and ids; the PaymentProvider drives the terminal through the processor's cloud API and answers
 * with an outcome, brand, last four and an opaque reference. Card data never reaches us.
 *
 * Idempotent by the register-minted key (tender_id for a charge, refund_id for a refund): the first
 * call is recorded in `payment_attempts`, and any retry returns that record without calling the
 * processor again. Refunds are only accepted against this merchant's own approved charges and never
 * for more than is left on them.
 */
import type { DevicePrincipal } from '../auth/principal';
import type { Db } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import type { PaymentProvider, PaymentResult } from '../payments';

export interface CardOutcome {
  status: 'approved' | 'declined' | 'error';
  provider: string;
  provider_ref: string | null;
  approval_code: string | null;
  brand: string | null;
  last4: string | null;
  /** Safe for the cashier; the customer screen shows its own neutral copy (no processor names). */
  message: string | null;
  replayed: boolean;
}

interface AttemptRow {
  status: CardOutcome['status'] | 'pending';
  provider: string;
  provider_ref: string | null;
  approval_code: string | null;
  brand: string | null;
  last4: string | null;
  message: string | null;
  kind: 'charge' | 'refund';
  register_id: string;
}

const outcome = (r: AttemptRow, replayed: boolean): CardOutcome => ({
  status: r.status === 'pending' ? 'error' : r.status,
  provider: r.provider,
  provider_ref: r.provider_ref,
  approval_code: r.approval_code,
  brand: r.brand,
  last4: r.last4,
  message: r.message,
  replayed,
});

async function existing(db: Db, key: string, d: DevicePrincipal, kind: 'charge' | 'refund'): Promise<CardOutcome | null> {
  const { rows } = await db.query<AttemptRow>(
    `SELECT status, provider, provider_ref, approval_code, brand, last4, message, kind, register_id
       FROM payment_attempts WHERE idempotency_key = $1 AND merchant_id = $2`,
    [key, d.merchant_id],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.kind !== kind || r.register_id !== d.register_id) throw badRequest('That payment id was already used for something else');
  return outcome(r, true);
}

async function record(
  db: Db,
  d: DevicePrincipal,
  key: string,
  kind: 'charge' | 'refund',
  saleId: string,
  amount: number,
  provider: string,
  res: PaymentResult,
  traceId: string,
  refundsRef: string | null,
): Promise<CardOutcome> {
  const status = res.status === 'pending' ? 'error' : res.status;
  const last4 = res.card?.last4 && /^\d{4}$/.test(res.card.last4) ? res.card.last4 : null;
  // ON CONFLICT: two retries racing both reach here; the first row wins and both answer with it.
  const ins = await db.query<{ k: string }>(
    `INSERT INTO payment_attempts (idempotency_key, kind, org_id, merchant_id, location_id, register_id, sale_id, amount_cents, provider,
                                   status, provider_ref, approval_code, brand, last4, message, refunds_ref, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key AS k`,
    [key, kind, d.org_id, d.merchant_id, d.location_id, d.register_id, saleId, amount, provider, status, res.provider_ref, res.approval_code, res.card?.brand ?? null, last4, res.message, refundsRef, traceId],
  );
  const stored = (await existing(db, key, d, kind))!;
  return { ...stored, replayed: ins.rows.length === 0 };
}

export async function terminalCharge(
  db: Db,
  payments: PaymentProvider,
  d: DevicePrincipal,
  input: { sale_id: string; tender_id: string; amount_cents: number },
  traceId: string,
): Promise<CardOutcome> {
  const prior = await existing(db, input.tender_id, d, 'charge');
  if (prior) return prior;
  let res: PaymentResult;
  try {
    res = await payments.terminalCharge({
      tenancy: { org_id: d.org_id, merchant_id: d.merchant_id, location_id: d.location_id, register_id: d.register_id },
      // One terminal per register until terminal pairing lands with the PAX A35 (P-HW).
      terminal_id: d.register_id,
      amount_cents: input.amount_cents,
      idempotency_key: input.tender_id,
      sale_id: input.sale_id,
    });
  } catch (e) {
    // Not recorded: we don't know if the processor charged, so a retry must ask it again (its own
    // idempotency on the same key prevents a second charge).
    return { status: 'error', provider: payments.name, provider_ref: null, approval_code: null, brand: null, last4: null, message: `Card machine not reachable: ${(e as Error).message.slice(0, 120)}`, replayed: false };
  }
  return record(db, d, input.tender_id, 'charge', input.sale_id, input.amount_cents, payments.name, res, traceId, null);
}

export async function cardRefund(
  db: Db,
  payments: PaymentProvider,
  d: DevicePrincipal,
  input: { sale_id: string; refund_id: string; provider_ref: string; amount_cents: number },
  traceId: string,
): Promise<CardOutcome> {
  const prior = await existing(db, input.refund_id, d, 'refund');
  if (prior) return prior;
  const { rows } = await db.query<{ amount_cents: number; refunded: number }>(
    `SELECT c.amount_cents,
            coalesce((SELECT sum(r.amount_cents) FROM payment_attempts r
                       WHERE r.kind = 'refund' AND r.merchant_id = c.merchant_id AND r.refunds_ref = c.provider_ref AND r.status = 'approved'), 0)::bigint AS refunded
       FROM payment_attempts c
      WHERE c.kind = 'charge' AND c.status = 'approved' AND c.merchant_id = $1 AND c.provider_ref = $2`,
    [d.merchant_id, input.provider_ref],
  );
  const charge = rows[0];
  if (!charge) throw notFound('No approved card charge with that reference at this store');
  if (input.amount_cents > charge.amount_cents - charge.refunded) throw badRequest('That is more than is left to refund on this card payment');
  let res: PaymentResult;
  try {
    res = await payments.refund(input.provider_ref, input.amount_cents, input.refund_id);
  } catch (e) {
    return { status: 'error', provider: payments.name, provider_ref: null, approval_code: null, brand: null, last4: null, message: `Card processor not reachable: ${(e as Error).message.slice(0, 120)}`, replayed: false };
  }
  return record(db, d, input.refund_id, 'refund', input.sale_id, input.amount_cents, payments.name, res, traceId, input.provider_ref);
}
