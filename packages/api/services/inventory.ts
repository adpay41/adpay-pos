/**
 * Inventory (P22, ADR 0034): stock levels folded from movements and sales, movements from the
 * merchant app, per-item stock settings (tracking, low-stock point, case-break, perishable), and the
 * register's inventory events copied into the one append-only movements table on ingest.
 */
import {
  foldSale,
  foldStock,
  isDeadStock,
  RegisterEventSchema,
  type InventoryMovementInput,
  type ItemStockSettings,
  type Movement,
  type RegisterEvent,
} from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, merchantFor } from './catalog-write';

type Actor = MerchantUserPrincipal | AdminPrincipal;

export interface StockRow {
  item_id: string;
  name: string;
  category: string | null;
  on_hand: number;
  reorder_point: number | null;
  low: boolean;
  dead: boolean;
  counted_at: string | null;
  last_sold_at: string | null;
  perishable: boolean;
  /** Pack sizes that count toward this item ("Carton = 10"). */
  packs: { item_id: string; name: string; ratio: number }[];
}

export interface ExpiringLot {
  item_id: string;
  name: string;
  expires_on: string;
  /** What's left of it at most: never more than the item's stock. */
  qty: number;
}

/** Register inventory events → movements (idempotent on the event id). */
export async function movementsFromEvents(q: Queryable, events: readonly RegisterEvent[]): Promise<void> {
  type Row = { movement_id: string; org_id: string; merchant_id: string; location_id: string; register_id: string; actor_user_id: string | null; occurred_at: string; trace_id: string;
    item_id: string; kind: string; qty: number; reason: string | null; note: string | null; invoice_ref: string | null; expires_on: string | null; receipt_id: string | null; po_id?: string | null };
  const rows = events.flatMap((e): Row[] => {
    const base = { movement_id: e.event_id, org_id: e.org_id, merchant_id: e.merchant_id, location_id: e.location_id, register_id: e.register_id, actor_user_id: e.actor_user_id ?? null, occurred_at: e.occurred_at, trace_id: e.trace_id };
    if (e.type === 'inventory.received') return [{ ...base, item_id: e.payload.item_id, kind: 'receive', qty: e.payload.qty, reason: null, note: null, invoice_ref: e.payload.invoice_ref, expires_on: e.payload.expires_on, receipt_id: e.payload.receipt_id, po_id: e.payload.po_id ?? null }];
    if (e.type === 'inventory.written_off') return [{ ...base, item_id: e.payload.item_id, kind: 'adjust', qty: -e.payload.qty, reason: e.payload.reason, note: e.payload.note, invoice_ref: null, expires_on: null, receipt_id: null }];
    if (e.type === 'inventory.counted') return [{ ...base, item_id: e.payload.item_id, kind: 'count', qty: e.payload.qty, reason: null, note: null, invoice_ref: null, expires_on: null, receipt_id: null }];
    return [];
  });
  if (!rows.length) return;
  await q.query(
    `INSERT INTO inventory_movements (movement_id, org_id, merchant_id, location_id, item_id, kind, qty, reason, note, invoice_ref, expires_on, receipt_id, po_id, source, register_id, actor_user_id, occurred_at, trace_id)
     SELECT x.movement_id, x.org_id, x.merchant_id, x.location_id, x.item_id, x.kind, x.qty, x.reason, x.note, x.invoice_ref, x.expires_on, x.receipt_id, x.po_id, 'register', x.register_id, x.actor_user_id, x.occurred_at, x.trace_id
       FROM jsonb_to_recordset($1::jsonb) AS x(movement_id uuid, org_id uuid, merchant_id uuid, location_id uuid, item_id uuid, kind text, qty int, reason text, note text,
            invoice_ref text, expires_on date, receipt_id uuid, po_id uuid, register_id uuid, actor_user_id uuid, occurred_at timestamptz, trace_id text)
       JOIN items i ON i.item_id = x.item_id AND i.merchant_id = x.merchant_id
     ON CONFLICT (movement_id) DO NOTHING`,
    [JSON.stringify(rows)],
  );
}

/** Stock at one store for every tracked item, and perishable lots close to their date. */
export async function stockLevels(q: Queryable, merchantId: string, locationId: string, now = new Date()): Promise<{ items: StockRow[]; expiring: ExpiringLot[] }> {
  const { rows: loc } = await q.query('SELECT 1 FROM locations WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId]);
  if (!loc[0]) throw notFound('Location not found');
  const { rows: items } = await q.query<{ item_id: string; name: string; category: string | null; track_stock: boolean; reorder_point: number | null; stock_of: string | null; stock_ratio: number; perishable: boolean }>(
    `SELECT i.item_id, i.name, c.name AS category, i.track_stock, i.reorder_point, i.stock_of, i.stock_ratio, i.perishable
       FROM items i LEFT JOIN categories c ON c.category_id = i.category_id
      WHERE i.merchant_id = $1 AND (i.track_stock OR i.stock_of IS NOT NULL)`,
    [merchantId],
  );
  if (items.length === 0) return { items: [], expiring: [] };
  const ids = items.map((i) => i.item_id);
  const { rows: moves } = await q.query<{ item_id: string; kind: Movement['kind']; qty: number; occurred_at: Date; expires_on: string | null }>(
    `SELECT item_id, kind, qty, occurred_at, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM inventory_movements
      WHERE merchant_id = $1 AND location_id = $2 AND item_id = ANY($3::uuid[]) ORDER BY occurred_at`,
    [merchantId, locationId, ids],
  );
  // Sales since the earliest point that can still matter: the oldest last count, or the first movement; at most a year.
  const lastCount = new Map<string, string>();
  for (const m of moves) if (m.kind === 'count') lastCount.set(m.item_id, m.occurred_at.toISOString());
  const starts = [...lastCount.values(), ...(moves[0] ? [moves[0].occurred_at.toISOString()] : [])];
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString();
  const since = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : yearAgo;
  const { rows: evs } = await q.query<Record<string, unknown> & { occurred_at: Date }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id, e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload
       FROM sale_events e
      WHERE e.location_id = $1 AND e.sale_id IN (
              SELECT c.sale_id FROM sale_events c WHERE c.location_id = $1 AND c.type = 'sale.completed' AND c.occurred_at >= $2::timestamptz
                 AND EXISTS (SELECT 1 FROM sale_events l WHERE l.sale_id = c.sale_id AND l.type = 'sale.line_added' AND (l.payload->>'item_id')::uuid = ANY($3::uuid[])))
      ORDER BY e.sale_id, e.device_seq`,
    [locationId, since > yearAgo ? since : yearAgo, ids],
  );
  const bySale = new Map<string, RegisterEvent[]>();
  for (const r of evs) {
    const e = RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() });
    bySale.set(e.sale_id!, [...(bySale.get(e.sale_id!) ?? []), e]);
  }
  const sales = [...bySale.entries()].map(([id, events]) => ({ ...foldSale(id, events), occurred_at: events.find((e) => e.type === 'sale.completed')!.occurred_at }));
  const levels = foldStock(
    items.map((i) => ({ item_id: i.item_id, stock_of: i.stock_of, stock_ratio: i.stock_ratio })),
    moves.map((m) => ({ item_id: m.item_id, kind: m.kind, qty: m.qty, at: m.occurred_at.toISOString() })),
    sales,
  );

  const rows: StockRow[] = items
    .filter((i) => i.track_stock && !i.stock_of)
    .map((i) => {
      const l = levels.get(i.item_id) ?? { on_hand: 0, counted_at: null, last_sold_at: null };
      return {
        item_id: i.item_id,
        name: i.name,
        category: i.category,
        on_hand: l.on_hand,
        reorder_point: i.reorder_point,
        low: i.reorder_point !== null && l.on_hand <= i.reorder_point,
        dead: isDeadStock(l, now),
        counted_at: l.counted_at,
        last_sold_at: l.last_sold_at,
        perishable: i.perishable,
        packs: items.filter((p) => p.stock_of === i.item_id).map((p) => ({ item_id: p.item_id, name: p.name, ratio: p.stock_ratio })),
      };
    })
    .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));

  // Perishable lots dated within 3 days (or past), capped at what the shelf can still hold.
  const soon = new Date(now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
  const expiring: ExpiringLot[] = [];
  for (const m of moves) {
    if (m.kind !== 'receive' || !m.expires_on || m.expires_on > soon) continue;
    const item = items.find((i) => i.item_id === m.item_id)!;
    const baseId = item.stock_of ?? item.item_id;
    const onHand = levels.get(baseId)?.on_hand ?? 0;
    if (onHand <= 0) continue;
    const counted = levels.get(baseId)?.counted_at;
    if (counted && m.occurred_at.toISOString() < counted) continue; // counted since: the lot is in that count
    expiring.push({ item_id: baseId, name: items.find((i) => i.item_id === baseId)?.name ?? item.name, expires_on: m.expires_on, qty: Math.min(onHand, m.qty * (item.stock_of ? item.stock_ratio : 1)) });
  }
  expiring.sort((a, b) => a.expires_on.localeCompare(b.expires_on));
  return { items: rows, expiring };
}

/** A count, receipt or write-off typed in the merchant app. */
export async function recordMovement(db: Db, actor: Actor, merchantId: string, m: InventoryMovementInput, traceId: string): Promise<{ movement_id: string }> {
  return db.tx(async (q) => {
    const merchant = await merchantFor(q, merchantId);
    const { rows: loc } = await q.query('SELECT 1 FROM locations WHERE location_id = $1 AND merchant_id = $2', [m.location_id, merchantId]);
    if (!loc[0]) throw notFound('Location not found');
    const { rows: it } = await q.query<{ track_stock: boolean; stock_of: string | null }>('SELECT track_stock, stock_of FROM items WHERE item_id = $1 AND merchant_id = $2', [m.item_id, merchantId]);
    if (!it[0]) throw notFound('Item not found');
    if (!it[0].track_stock && !it[0].stock_of) throw badRequest('Turn on stock tracking for this item first');
    const id = randomUUID();
    const kind = m.kind === 'write_off' ? 'adjust' : m.kind;
    const qty = m.kind === 'write_off' ? -m.qty : m.qty;
    await q.query(
      `INSERT INTO inventory_movements (movement_id, org_id, merchant_id, location_id, item_id, kind, qty, reason, note, invoice_ref, expires_on, source, actor_user_id, occurred_at, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'app', $12, now(), $13)`,
      [
        id, merchant.org_id, merchantId, m.location_id, m.item_id, kind, qty,
        m.kind === 'write_off' ? m.reason : null, 'note' in m ? m.note : null, m.kind === 'receive' ? m.invoice_ref : null, m.kind === 'receive' ? m.expires_on : null,
        actor.user_id, traceId,
      ],
    );
    await audit(q, { actor, action: `inventory.${m.kind}`, tenancy: { ...merchant, location_id: m.location_id }, target: m.item_id, details: m, trace_id: traceId });
    return { movement_id: id };
  });
}

export async function setStockSettings(db: Db, actor: Actor, merchantId: string, itemId: string, s: ItemStockSettings, traceId: string) {
  return db.tx(async (q) => {
    const merchant = await merchantFor(q, merchantId);
    const { rows } = await q.query('SELECT 1 FROM items WHERE item_id = $1 AND merchant_id = $2 FOR UPDATE', [itemId, merchantId]);
    if (!rows[0]) throw notFound('Item not found');
    if (s.stock_of) {
      if (s.stock_of === itemId) throw badRequest('An item can’t be a pack of itself');
      const { rows: parent } = await q.query<{ stock_of: string | null }>('SELECT stock_of FROM items WHERE item_id = $1 AND merchant_id = $2', [s.stock_of, merchantId]);
      if (!parent[0]) throw badRequest('That item isn’t in this catalog');
      if (parent[0].stock_of) throw badRequest('Break into the single item itself, not into another pack');
      const { rows: kids } = await q.query('SELECT 1 FROM items WHERE stock_of = $1 LIMIT 1', [itemId]);
      if (kids[0]) throw badRequest('Other packs break into this item; it can’t be a pack itself');
      await q.query('UPDATE items SET track_stock = true WHERE item_id = $1', [s.stock_of]);
    }
    await q.query(
      'UPDATE items SET track_stock = $2, reorder_point = $3, stock_of = $4, stock_ratio = $5, perishable = $6, updated_at = now() WHERE item_id = $1',
      [itemId, s.track_stock || s.stock_of !== null, s.stock_of ? null : s.reorder_point, s.stock_of, s.stock_ratio, s.perishable],
    );
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, { actor, action: 'inventory.settings_set', tenancy: merchant, target: itemId, details: { ...s, catalog_version: version }, trace_id: traceId });
    return { item_id: itemId, catalog_version: version };
  });
}
