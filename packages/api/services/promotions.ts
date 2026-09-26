/**
 * Promotions (P20a, ADR 0031): the merchant's promotions builder, and what the register gets.
 * Editing a promotion bumps the catalog version, so every register picks it up at its next sync.
 * Usage comes from the sales: each promotional discount event carries the promotion's id.
 */
import { PromotionInput, type Promotion } from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';

interface Row {
  promo_id: string;
  name: string;
  rule: unknown;
  item_ids: string[];
  category_ids: string[];
  location_ids: string[] | null;
  starts_on: string;
  ends_on: string | null;
  days: number[] | null;
  start_time: string | null;
  end_time: string | null;
  show_on_idle: boolean;
  active: boolean;
}

const SELECT = `SELECT promo_id, name, rule, item_ids, category_ids, location_ids, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
                       to_char(ends_on, 'YYYY-MM-DD') AS ends_on, days, start_time, end_time, show_on_idle, active
                  FROM promotions`;

function toPromotion(r: Row): Promotion | null {
  const parsed = PromotionInput.safeParse({
    name: r.name, rule: r.rule, item_ids: r.item_ids, category_ids: r.category_ids, location_ids: r.location_ids, starts_on: r.starts_on,
    ends_on: r.ends_on, days: r.days, start_time: r.start_time, end_time: r.end_time, show_on_idle: r.show_on_idle,
  });
  return parsed.success ? { ...parsed.data, promo_id: r.promo_id, active: r.active } : null;
}

/** For the register snapshot: active promotions for this store that haven't ended. */
export async function promotionsForLocation(q: Queryable, merchantId: string, locationId: string, today: string): Promise<Promotion[]> {
  const { rows } = await q.query<Row>(
    `${SELECT} WHERE merchant_id = $1 AND active AND (location_ids IS NULL OR $2 = ANY(location_ids)) AND (ends_on IS NULL OR ends_on >= $3::date) ORDER BY created_at`,
    [merchantId, locationId, today],
  );
  return rows.map(toPromotion).filter((p): p is Promotion => p !== null);
}

/** For the builder: every promotion, newest first, with what it has given in the last 30 days. */
export async function listPromotions(q: Queryable, merchantId: string) {
  const { rows } = await q.query<Row & { uses: number; given_cents: number }>(
    `${SELECT.replace('FROM promotions', `,
       (SELECT count(DISTINCT e.sale_id)::int FROM sale_events e
         WHERE e.merchant_id = promotions.merchant_id AND e.type = 'sale.line_discounted' AND e.payload->>'promo_id' = promotions.promo_id::text
           AND e.occurred_at > now() - interval '30 days') AS uses,
       (SELECT coalesce(sum((e.payload->>'cash_discount_cents')::bigint), 0)::bigint FROM sale_events e
         WHERE e.merchant_id = promotions.merchant_id AND e.type = 'sale.line_discounted' AND e.payload->>'promo_id' = promotions.promo_id::text
           AND e.occurred_at > now() - interval '30 days') AS given_cents
       FROM promotions`)} WHERE merchant_id = $1 ORDER BY active DESC, created_at DESC`,
    [merchantId],
  );
  return rows.flatMap((r) => {
    const p = toPromotion(r);
    return p ? [{ ...p, uses_30d: r.uses, given_30d_cents: Number(r.given_cents) }] : [];
  });
}

async function assertOwnIds(q: Queryable, merchantId: string, p: PromotionInput): Promise<void> {
  const check = async (table: string, col: string, ids: string[]) => {
    if (!ids.length) return;
    const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE merchant_id = $1 AND ${col} = ANY($2::uuid[])`, [merchantId, ids]);
    if (rows[0]!.n !== new Set(ids).size) throw badRequest(`Some of those ${table} aren’t in this store’s catalog`);
  };
  await check('items', 'item_id', p.item_ids);
  await check('categories', 'category_id', p.category_ids);
  await check('locations', 'location_id', p.location_ids ?? []);
}

export async function savePromotion(
  db: Db,
  actor: MerchantUserPrincipal | AdminPrincipal,
  merchantId: string,
  promoId: string | null,
  p: PromotionInput,
  traceId: string,
): Promise<{ promo_id: string; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows: m } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
    if (!m[0]) throw notFound('Merchant not found');
    await assertOwnIds(q, merchantId, p);
    const values = [p.name, JSON.stringify(p.rule), p.item_ids, p.category_ids, p.location_ids, p.starts_on, p.ends_on, p.days, p.start_time, p.end_time, p.show_on_idle];
    let id = promoId;
    if (id) {
      const { rows } = await q.query(
        `UPDATE promotions SET name = $3, rule = $4, item_ids = $5, category_ids = $6, location_ids = $7, starts_on = $8, ends_on = $9, days = $10,
                start_time = $11, end_time = $12, show_on_idle = $13, updated_at = now()
          WHERE promo_id = $1 AND merchant_id = $2 RETURNING promo_id`,
        [id, merchantId, ...values],
      );
      if (!rows[0]) throw notFound('Promotion not found');
    } else {
      const { rows } = await q.query<{ promo_id: string }>(
        `INSERT INTO promotions (org_id, merchant_id, name, rule, item_ids, category_ids, location_ids, starts_on, ends_on, days, start_time, end_time, show_on_idle, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING promo_id`,
        [m[0].org_id, merchantId, ...values, actor.user_id],
      );
      id = rows[0]!.promo_id;
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, { actor, action: promoId ? 'promotion.updated' : 'promotion.created', tenancy: { org_id: m[0].org_id, merchant_id: merchantId }, target: id, details: { ...p, catalog_version: version }, trace_id: traceId });
    return { promo_id: id, catalog_version: version };
  });
}

/** Stop a promotion now (or bring it back). Sales it already gave keep their discounts. */
export async function setPromotionActive(db: Db, actor: MerchantUserPrincipal | AdminPrincipal, merchantId: string, promoId: string, active: boolean, traceId: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>('UPDATE promotions SET active = $3, updated_at = now() WHERE promo_id = $1 AND merchant_id = $2 RETURNING org_id', [promoId, merchantId, active]);
    if (!rows[0]) throw notFound('Promotion not found');
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, { actor, action: active ? 'promotion.resumed' : 'promotion.ended', tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: promoId, details: { catalog_version: version }, trace_id: traceId });
    return { promo_id: promoId, active, catalog_version: version };
  });
}
