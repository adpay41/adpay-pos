/**
 * Vendors, reorder suggestions and purchase orders (P23, ADR 0035).
 *
 * Suggestions read the store's stock (the P22 fold), the last four weeks of sales by weekday, what is
 * already on order, and the vendor's delivery days. A purchase order goes to the rep as a text or an
 * email through `MessageSender` (log in v1: recorded, not delivered, and the app says so). Receiving
 * against it at the register is ordinary inventory movements carrying its id, so "what arrived vs what
 * was ordered" is read, never kept.
 */
import {
  foldSale,
  localDate,
  normalizeUsPhone,
  orderText,
  RegisterEventSchema,
  suggestReorder,
  type PurchaseOrderInput,
  type RegisterEvent,
  type VendorInput,
} from '@adpay/shared';
import { createHash } from 'node:crypto';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { maskRecipient, type MessageSender } from '../messaging/sender';
import { audit } from './audit';
import { merchantFor } from './catalog-write';
import { stockLevels } from './inventory';

type Actor = MerchantUserPrincipal | AdminPrincipal;

export interface Vendor extends VendorInput {
  vendor_id: string;
  active: boolean;
  items: number;
}

export async function vendors(q: Queryable, merchantId: string): Promise<Vendor[]> {
  const { rows } = await q.query<Vendor>(
    `SELECT v.vendor_id, v.name, v.phone, v.email, v.order_via, v.delivery_days, v.note, v.active,
            (SELECT count(*)::int FROM items i WHERE i.vendor_id = v.vendor_id) AS items
       FROM vendors v WHERE v.merchant_id = $1 ORDER BY v.active DESC, v.name`,
    [merchantId],
  );
  return rows;
}

export async function saveVendor(db: Db, actor: Actor, merchantId: string, vendorId: string | null, v: VendorInput, traceId: string) {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const phone = v.phone ? normalizeUsPhone(v.phone) : null;
    if (v.phone && !phone) throw badRequest('That isn’t a US phone number');
    const values = [v.name, phone, v.email, v.order_via, v.delivery_days, v.note];
    let id = vendorId;
    if (id) {
      const { rows } = await q.query('UPDATE vendors SET name = $3, phone = $4, email = $5, order_via = $6, delivery_days = $7, note = $8, updated_at = now() WHERE vendor_id = $1 AND merchant_id = $2 RETURNING vendor_id', [id, merchantId, ...values]);
      if (!rows[0]) throw notFound('Vendor not found');
    } else {
      const { rows } = await q.query<{ vendor_id: string }>('INSERT INTO vendors (org_id, merchant_id, name, phone, email, order_via, delivery_days, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING vendor_id', [m.org_id, merchantId, ...values]);
      id = rows[0]!.vendor_id;
    }
    await audit(q, { actor, action: vendorId ? 'vendor.updated' : 'vendor.created', tenancy: m, target: id, details: { name: v.name, order_via: v.order_via }, trace_id: traceId });
    return { vendor_id: id };
  });
}

/** Who supplies these items (null = nobody). */
export async function setItemsVendor(db: Db, actor: Actor, merchantId: string, vendorId: string | null, itemIds: string[], traceId: string) {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    if (vendorId) {
      const { rows } = await q.query('SELECT 1 FROM vendors WHERE vendor_id = $1 AND merchant_id = $2', [vendorId, merchantId]);
      if (!rows[0]) throw notFound('Vendor not found');
    }
    const { rows } = await q.query('UPDATE items SET vendor_id = $3, updated_at = now() WHERE merchant_id = $1 AND item_id = ANY($2::uuid[]) RETURNING item_id', [merchantId, itemIds, vendorId]);
    await audit(q, { actor, action: 'vendor.items_set', tenancy: m, target: vendorId ?? 'none', details: { items: rows.length }, trace_id: traceId });
    return { updated: rows.length };
  });
}

/** Units per item not yet received on sent orders at this store. */
async function onOrder(q: Queryable, merchantId: string, locationId: string): Promise<Map<string, number>> {
  const { rows } = await q.query<{ item_id: string; ordered: number; received: number }>(
    `SELECT l.item_id, sum(l.qty)::int AS ordered,
            coalesce((SELECT sum(m.qty) FROM inventory_movements m WHERE m.po_id = po.po_id AND m.item_id = l.item_id AND m.kind = 'receive'), 0)::int AS received
       FROM purchase_orders po, jsonb_to_recordset(po.lines) AS l(item_id uuid, qty int)
      WHERE po.merchant_id = $1 AND po.location_id = $2 AND po.status = 'sent'
      GROUP BY po.po_id, l.item_id`,
    [merchantId, locationId],
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.item_id, (out.get(r.item_id) ?? 0) + Math.max(0, r.ordered - r.received));
  return out;
}

export interface Suggestion {
  item_id: string;
  name: string;
  on_hand: number;
  on_order: number;
  forecast: number;
  qty: number;
  until: string;
  case_qty: number;
}

/** What to order from each vendor now, for one store. */
export async function reorderSuggestions(q: Queryable, merchantId: string, locationId: string, now = new Date()) {
  const { rows: loc } = await q.query<{ timezone: string }>('SELECT timezone FROM locations WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId]);
  if (!loc[0]) throw notFound('Location not found');
  const today = localDate(now, loc[0].timezone);
  const stock = await stockLevels(q, merchantId, locationId, now);
  const { rows: items } = await q.query<{ item_id: string; name: string; vendor_id: string | null; stock_of: string | null; stock_ratio: number; case_qty: number }>(
    `SELECT i.item_id, i.name, i.vendor_id, i.stock_of, i.stock_ratio,
            coalesce((SELECT max(b.pack_qty) FROM item_barcodes b WHERE b.item_id = i.item_id AND b.pack_qty > 1), 1) AS case_qty
       FROM items i WHERE i.merchant_id = $1 AND (i.track_stock OR i.stock_of IS NOT NULL)`,
    [merchantId],
  );
  // Units sold per base item per day for the 28 days ending yesterday (store-local days).
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10);
  const { rows: evs } = await q.query<Record<string, unknown> & { occurred_at: Date; business_date: string }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id, e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload,
            to_char(c.business_date, 'YYYY-MM-DD') AS business_date
       FROM sale_events c JOIN sale_events e ON e.sale_id = c.sale_id
      WHERE c.location_id = $1 AND c.type = 'sale.completed' AND c.business_date >= $2::date AND c.business_date < $3::date
      ORDER BY e.sale_id, e.device_seq`,
    [locationId, from, today],
  );
  const bySale = new Map<string, { events: RegisterEvent[]; day: string }>();
  for (const r of evs) {
    const { business_date, ...raw } = r;
    const e = RegisterEventSchema.parse({ ...raw, occurred_at: new Date(r.occurred_at).toISOString() });
    const cur = bySale.get(e.sale_id!) ?? { events: [], day: business_date };
    cur.events.push(e);
    bySale.set(e.sale_id!, cur);
  }
  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const daily = new Map<string, number[]>();
  for (const [id, { events, day }] of bySale) {
    const s = foldSale(id, events);
    if (s.status !== 'completed') continue;
    const idx = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
    if (idx < 0 || idx >= 28) continue;
    for (const l of s.lines) {
      const it = itemById.get(l.item_id);
      if (!it) continue;
      const base = it.stock_of ?? it.item_id;
      const units = (l.qty - (s.refunded_qty[l.line_id] ?? 0)) * (it.stock_of ? it.stock_ratio : 1);
      const arr = daily.get(base) ?? Array.from({ length: 28 }, () => 0);
      arr[idx]! += units;
      daily.set(base, arr);
    }
  }
  const ordered = await onOrder(q, merchantId, locationId);
  const vendorList = (await vendors(q, merchantId)).filter((v) => v.active);
  return {
    today,
    vendors: vendorList.map((v) => ({
      vendor_id: v.vendor_id,
      name: v.name,
      delivery_days: v.delivery_days,
      suggestions: stock.items
        .filter((row) => itemById.get(row.item_id)?.vendor_id === v.vendor_id)
        .map((row): Suggestion => {
          const it = itemById.get(row.item_id)!;
          const r = suggestReorder(
            { item_id: row.item_id, on_hand: row.on_hand, on_order: ordered.get(row.item_id) ?? 0, reorder_point: row.reorder_point, daily_units: daily.get(row.item_id) ?? Array.from({ length: 28 }, () => 0), case_qty: it.case_qty },
            today,
            v.delivery_days,
          );
          return { item_id: row.item_id, name: row.name, on_hand: row.on_hand, on_order: ordered.get(row.item_id) ?? 0, forecast: r.forecast, qty: r.qty, until: r.until, case_qty: it.case_qty };
        })
        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
    })),
  };
}

export async function createPurchaseOrder(db: Db, actor: Actor, merchantId: string, po: PurchaseOrderInput, traceId: string) {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const { rows: v } = await q.query('SELECT 1 FROM vendors WHERE vendor_id = $1 AND merchant_id = $2', [po.vendor_id, merchantId]);
    if (!v[0]) throw notFound('Vendor not found');
    const { rows: loc } = await q.query('SELECT 1 FROM locations WHERE location_id = $1 AND merchant_id = $2', [po.location_id, merchantId]);
    if (!loc[0]) throw notFound('Location not found');
    const ids = po.lines.map((l) => l.item_id);
    const { rows: its } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM items WHERE merchant_id = $1 AND item_id = ANY($2::uuid[])', [merchantId, ids]);
    if (its[0]!.n !== new Set(ids).size) throw badRequest('Some of those items aren’t in this store’s catalog');
    const { rows } = await q.query<{ po_id: string }>(
      `INSERT INTO purchase_orders (org_id, merchant_id, location_id, vendor_id, status, lines, note, created_by) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7) RETURNING po_id`,
      [m.org_id, merchantId, po.location_id, po.vendor_id, JSON.stringify(po.lines), po.note, actor.user_id],
    );
    await audit(q, { actor, action: 'po.created', tenancy: { ...m, location_id: po.location_id }, target: rows[0]!.po_id, details: { vendor_id: po.vendor_id, lines: po.lines.length }, trace_id: traceId });
    return { po_id: rows[0]!.po_id };
  });
}

/** Send a draft to the rep: a text or an email with the lines, then it counts as on order. */
export async function sendPurchaseOrder(db: Db, sender: MessageSender, actor: Actor, merchantId: string, poId: string, traceId: string) {
  const { rows } = await db.query<{ org_id: string; location_id: string; status: string; lines: { item_id: string; qty: number }[]; note: string | null; vendor: string; phone: string | null; email: string | null; order_via: 'sms' | 'email'; store: string }>(
    `SELECT po.org_id, po.location_id, po.status, po.lines, po.note, v.name AS vendor, v.phone, v.email, v.order_via, m.name AS store
       FROM purchase_orders po JOIN vendors v ON v.vendor_id = po.vendor_id JOIN merchants m ON m.merchant_id = po.merchant_id
      WHERE po.po_id = $1 AND po.merchant_id = $2`,
    [poId, merchantId],
  );
  const po = rows[0];
  if (!po) throw notFound('Order not found');
  if (po.status !== 'draft') throw badRequest('Only a draft order can be sent');
  const to = po.order_via === 'sms' ? po.phone : po.email;
  if (!to) throw badRequest('This vendor has no phone or email for orders');
  const { rows: names } = await db.query<{ item_id: string; name: string }>('SELECT item_id, name FROM items WHERE item_id = ANY($1::uuid[])', [po.lines.map((l) => l.item_id)]);
  const nameOf = new Map(names.map((n) => [n.item_id, n.name]));
  const body = orderText(po.store, po.vendor, po.lines.map((l) => ({ name: nameOf.get(l.item_id) ?? 'item', qty: l.qty })), po.note);
  const result = await sender.send({ channel: po.order_via, to, subject: po.order_via === 'email' ? `Order from ${po.store}` : null, body });
  await db.tx(async (q) => {
    await q.query("UPDATE purchase_orders SET status = 'sent', sent_at = now(), send_status = $3 WHERE po_id = $1 AND merchant_id = $2", [poId, merchantId, result.status]);
    await q.query(
      `INSERT INTO outbound_messages (org_id, merchant_id, location_id, channel, purpose, to_masked, to_hash, provider, status, provider_ref, error, created_by, trace_id)
       VALUES ($1, $2, $3, $4, 'order', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [po.org_id, merchantId, po.location_id, po.order_via, maskRecipient(to), createHash('sha256').update(`${merchantId}:${to}`).digest('hex'), sender.name, result.status, result.provider_ref, result.error, actor.user_id, traceId],
    );
    await audit(q, { actor, action: 'po.sent', tenancy: { org_id: po.org_id, merchant_id: merchantId, location_id: po.location_id }, target: poId, details: { via: po.order_via, to: maskRecipient(to), status: result.status }, trace_id: traceId });
  });
  return { status: result.status, delivered: sender.delivers && result.status === 'sent', to: maskRecipient(to) };
}

export async function closePurchaseOrder(db: Db, actor: Actor, merchantId: string, poId: string, to: 'received' | 'cancelled', traceId: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; status: string }>('SELECT org_id, status FROM purchase_orders WHERE po_id = $1 AND merchant_id = $2 FOR UPDATE', [poId, merchantId]);
    if (!rows[0]) throw notFound('Order not found');
    if (rows[0].status === 'received' || rows[0].status === 'cancelled') throw badRequest('That order is already closed');
    await q.query('UPDATE purchase_orders SET status = $3, closed_at = now() WHERE po_id = $1 AND merchant_id = $2', [poId, merchantId, to]);
    await audit(q, { actor, action: `po.${to}`, tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: poId, details: {}, trace_id: traceId });
    return { po_id: poId, status: to };
  });
}

/** Orders with what arrived against each line: the discrepancy report (Bible 2.4). */
export async function purchaseOrders(q: Queryable, merchantId: string, opts: { locationId?: string; open?: boolean } = {}) {
  const { rows } = await q.query<{ po_id: string; location_id: string; vendor_id: string; vendor: string; status: string; lines: { item_id: string; qty: number }[]; note: string | null; created_at: Date; sent_at: Date | null; send_status: string | null }>(
    `SELECT po.po_id, po.location_id, po.vendor_id, v.name AS vendor, po.status, po.lines, po.note, po.created_at, po.sent_at, po.send_status
       FROM purchase_orders po JOIN vendors v ON v.vendor_id = po.vendor_id
      WHERE po.merchant_id = $1 AND ($2::uuid IS NULL OR po.location_id = $2) AND (NOT $3 OR po.status IN ('draft', 'sent'))
      ORDER BY po.created_at DESC LIMIT 100`,
    [merchantId, opts.locationId ?? null, opts.open ?? false],
  );
  if (!rows.length) return [];
  const { rows: got } = await q.query<{ po_id: string; item_id: string; qty: number }>(
    `SELECT po_id, item_id, sum(qty)::int AS qty FROM inventory_movements WHERE po_id = ANY($1::uuid[]) AND kind = 'receive' GROUP BY po_id, item_id`,
    [rows.map((r) => r.po_id)],
  );
  const ids = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.item_id)).concat(got.map((g) => g.item_id)))];
  const { rows: names } = await q.query<{ item_id: string; name: string }>('SELECT item_id, name FROM items WHERE item_id = ANY($1::uuid[])', [ids]);
  const nameOf = new Map(names.map((n) => [n.item_id, n.name]));
  return rows.map((r) => {
    const received = new Map(got.filter((g) => g.po_id === r.po_id).map((g) => [g.item_id, g.qty]));
    const lines = r.lines.map((l) => ({ item_id: l.item_id, name: nameOf.get(l.item_id) ?? 'item', ordered: l.qty, received: received.get(l.item_id) ?? 0 }));
    // Anything received that wasn't on the order shows too.
    for (const [item_id, qty] of received) if (!r.lines.some((l) => l.item_id === item_id)) lines.push({ item_id, name: nameOf.get(item_id) ?? 'item', ordered: 0, received: qty });
    return {
      po_id: r.po_id,
      location_id: r.location_id,
      vendor_id: r.vendor_id,
      vendor: r.vendor,
      status: r.status,
      note: r.note,
      created_at: r.created_at.toISOString(),
      sent_at: r.sent_at ? r.sent_at.toISOString() : null,
      send_status: r.send_status,
      lines,
      discrepancies: lines.filter((l) => l.received > 0 || r.status !== 'draft').filter((l) => l.received !== l.ordered).length,
    };
  });
}
