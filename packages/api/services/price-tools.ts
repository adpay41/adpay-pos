/**
 * Bulk price change and the profit report (P20b, ADR 0032).
 *
 * A bulk change is previewed first (the same computation, nothing written), then applied in one
 * transaction: one catalog-version bump, one audit entry, and a price-history row per item, as a
 * single edit writes. The profit report folds the period's sales and prices each unit at the cost in
 * force when it was sold, from that history.
 */
import { adjustPrice, foldSale, marginReport, RegisterEventSchema, type BulkPriceInput, type FoldedSale, type MarginReport, type RegisterEvent } from '@adpay/shared';
import type { Db, Queryable } from '../db/db';
import { badRequest } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, merchantFor, recordPrice, type CatalogActor } from './catalog-write';

export interface BulkPriceResult {
  dry_run: boolean;
  changed: number;
  unchanged: number;
  /** Items whose new price would be below their cost. */
  below_cost: number;
  sample: { item_id: string; name: string; from_cents: number; to_cents: number; cost_cents: number | null }[];
  catalog_version: number | null;
}

export async function bulkPriceChange(db: Db, actor: CatalogActor, merchantId: string, input: BulkPriceInput, traceId: string): Promise<BulkPriceResult> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const { rows } = await q.query<{ item_id: string; name: string; cash_price_cents: number; card_price_cents: number | null; cost_cents: number | null }>(
      `SELECT item_id, name, cash_price_cents, card_price_cents, cost_cents FROM items
        WHERE merchant_id = $1 AND active AND NOT open_price AND (category_id = ANY($2::uuid[]) OR item_id = ANY($3::uuid[]))
        ORDER BY name
        FOR UPDATE`,
      [merchantId, input.category_ids, input.item_ids],
    );
    if (rows.length === 0) throw badRequest('Nothing to change: no active, fixed-price items there');
    const planned = rows.map((r) => {
      const to = adjustPrice(r.cash_price_cents, input.change, input.round);
      // An explicit card price moves with the cash price; "set" goes back to the derived card price.
      const card = r.card_price_cents === null || input.change.kind === 'set' ? null : adjustPrice(r.card_price_cents, input.change, 'none');
      return { ...r, to, card };
    });
    const changes = planned.filter((p) => p.to !== p.cash_price_cents || p.card !== p.card_price_cents);
    const result: BulkPriceResult = {
      dry_run: input.dry_run,
      changed: changes.length,
      unchanged: planned.length - changes.length,
      below_cost: planned.filter((p) => p.cost_cents !== null && p.to < p.cost_cents).length,
      sample: changes.slice(0, 50).map((p) => ({ item_id: p.item_id, name: p.name, from_cents: p.cash_price_cents, to_cents: p.to, cost_cents: p.cost_cents })),
      catalog_version: null,
    };
    if (input.dry_run || changes.length === 0) return result;
    const version = await bumpCatalogVersion(q, merchantId);
    for (const p of changes) {
      await q.query('UPDATE items SET cash_price_cents = $2, card_price_cents = $3, updated_at = now() WHERE item_id = $1', [p.item_id, p.to, p.card]);
      await recordPrice(q, m, p.item_id, { cash_price_cents: p.to, card_price_cents: p.card, cost_cents: p.cost_cents }, version, actor, traceId);
    }
    await audit(q, {
      actor,
      action: 'catalog.bulk_price_change',
      tenancy: m,
      target: merchantId,
      details: { change: input.change, round: input.round, category_ids: input.category_ids, item_ids: input.item_ids.length, changed: changes.length, below_cost: result.below_cost, catalog_version: version },
      trace_id: traceId,
    });
    return { ...result, catalog_version: version };
  });
}

/** Profit by category and item over a store-local date range (at most a quarter). */
export async function profitReport(q: Queryable, merchantId: string, from: string, to: string): Promise<MarginReport & { below_cost_items: { name: string; units: number }[] }> {
  const { rows } = await q.query<Record<string, unknown> & { occurred_at: Date }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id, e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload
       FROM sale_events e
      WHERE e.merchant_id = $1
        AND e.sale_id IN (SELECT c.sale_id FROM sale_events c WHERE c.merchant_id = $1 AND c.type = 'sale.completed' AND c.business_date BETWEEN $2::date AND $3::date)
      ORDER BY e.sale_id, e.device_seq`,
    [merchantId, from, to],
  );
  const bySale = new Map<string, RegisterEvent[]>();
  for (const r of rows) {
    const e = RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() });
    bySale.set(e.sale_id!, [...(bySale.get(e.sale_id!) ?? []), e]);
  }
  const sales: (FoldedSale & { occurred_at: string })[] = [...bySale.entries()].map(([id, events]) => ({
    ...foldSale(id, events),
    occurred_at: events.find((e) => e.type === 'sale.completed')!.occurred_at,
  }));

  // Cost in force when sold: the latest history row at or before the sale; else the item's current cost.
  const { rows: hist } = await q.query<{ item_id: string; cost_cents: number | null; at: Date }>(
    `SELECT h.item_id, h.cost_cents, h.changed_at AS at FROM item_price_history h WHERE h.merchant_id = $1 ORDER BY h.item_id, h.changed_at`,
    [merchantId],
  );
  const { rows: now } = await q.query<{ item_id: string; cost_cents: number | null }>('SELECT item_id, cost_cents FROM items WHERE merchant_id = $1', [merchantId]);
  const timeline = new Map<string, { at: string; cost: number | null }[]>();
  for (const h of hist) timeline.set(h.item_id, [...(timeline.get(h.item_id) ?? []), { at: h.at.toISOString(), cost: h.cost_cents }]);
  const current = new Map(now.map((r) => [r.item_id, r.cost_cents]));
  const costAt = (itemId: string, when: string): number | null => {
    const t = timeline.get(itemId);
    if (t) for (let i = t.length - 1; i >= 0; i--) if (t[i]!.at <= when) return t[i]!.cost;
    return current.get(itemId) ?? null;
  };
  const { rows: cats } = await q.query<{ category_id: string; name: string }>('SELECT category_id, name FROM categories WHERE merchant_id = $1', [merchantId]);
  const names = new Map(cats.map((c) => [c.category_id, c.name]));
  const report = marginReport(sales, costAt, (id) => (id ? (names.get(id) ?? 'Other') : 'No category'), { from, to });
  return { ...report, items: report.items.slice(0, 50), below_cost_items: report.items.filter((i) => i.units_below_cost > 0).map((i) => ({ name: i.name, units: i.units_below_cost })) };
}
