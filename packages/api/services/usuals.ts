/**
 * Cashier presets, "the usual" (build plan P14, Bible 1.1, ADR 0023). Saved from a ticket at the
 * register (online) and delivered to every register of the store in the config snapshot. Removing
 * one is a delete of configuration, not of any sale: nothing here touches the ledger.
 */
import { MAX_USUALS_PER_CASHIER, type CashierUsual } from '@adpay/shared';
import type { z } from 'zod';
import type { UsualInput } from '@adpay/shared';
import type { DevicePrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';

export async function usualsFor(q: Queryable, merchantId: string): Promise<CashierUsual[]> {
  const { rows } = await q.query<CashierUsual>('SELECT usual_id, user_id, label, lines FROM cashier_usuals WHERE merchant_id = $1 ORDER BY user_id, created_at', [merchantId]);
  return rows;
}

export async function saveUsual(db: Db, device: DevicePrincipal, input: z.infer<typeof UsualInput>, traceId: string): Promise<{ usual_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows: member } = await q.query('SELECT 1 FROM memberships WHERE user_id = $1 AND merchant_id = $2', [input.user_id, device.merchant_id]);
    if (!member[0]) throw badRequest('That person is not on this store’s staff');
    const ids = [...new Set(input.lines.map((l) => l.item_id))];
    const { rows: known } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND item_id = ANY($2::uuid[])', [device.merchant_id, ids]);
    if (known[0]!.n !== ids.length) throw badRequest('An item in that ticket isn’t in the catalog yet. Sync, then save it again.');
    const { rows: count } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM cashier_usuals WHERE merchant_id = $1 AND user_id = $2', [device.merchant_id, input.user_id]);
    if (count[0]!.n >= MAX_USUALS_PER_CASHIER) throw badRequest(`Up to ${MAX_USUALS_PER_CASHIER} usuals per person. Remove one first.`);
    const { rows } = await q.query<{ usual_id: string }>(
      'INSERT INTO cashier_usuals (org_id, merchant_id, user_id, label, lines) VALUES ($1, $2, $3, $4, $5) RETURNING usual_id',
      [device.org_id, device.merchant_id, input.user_id, input.label, JSON.stringify(input.lines)],
    );
    const version = await bumpCatalogVersion(q, device.merchant_id);
    await audit(q, { actor: device, action: 'usual.saved', tenancy: device, target: rows[0]!.usual_id, details: { ...input, catalog_version: version }, trace_id: traceId });
    return { usual_id: rows[0]!.usual_id, catalog_version: version };
  });
}

export async function removeUsual(db: Db, device: DevicePrincipal, usualId: string, traceId: string): Promise<{ catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ label: string; user_id: string }>('DELETE FROM cashier_usuals WHERE usual_id = $1 AND merchant_id = $2 RETURNING label, user_id', [usualId, device.merchant_id]);
    if (!rows[0]) throw notFound('No such usual');
    const version = await bumpCatalogVersion(q, device.merchant_id);
    await audit(q, { actor: device, action: 'usual.removed', tenancy: device, target: usualId, details: { ...rows[0], catalog_version: version }, trace_id: traceId });
    return { catalog_version: version };
  });
}
