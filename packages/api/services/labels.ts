/**
 * Shelf tags, the tag print queue, price labels and label templates (P21, ADR 0033).
 *
 * - A tag shows both prices as the register would charge them at that store (the location's dual
 *   rate, or the item's fixed card price), and the item's barcode. An item with no barcode gets an
 *   in-store UPC-A (number system 4) when its tag is printed, added to its barcodes, so the tag scans.
 * - Printing records the prices each tag showed; the queue is every item whose price has moved since.
 * - A price label for an open-price item (deli) is a price-embedded UPC-A the register rings at the
 *   printed price.
 */
import {
  barcodeKind,
  DEFAULT_LABEL_TEMPLATE,
  inStoreUpc,
  LabelTemplateInput,
  priceEmbeddedUpc,
  resolveDualPrice,
  tagContent,
  type TagContent,
  type TagItem,
} from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, merchantFor } from './catalog-write';
import { labelsPdf } from './label-pdf';

type Actor = MerchantUserPrincipal | AdminPrincipal;

export async function labelTemplates(q: Queryable, merchantId: string): Promise<{ template_id: string | null; settings: LabelTemplateInput }[]> {
  const { rows } = await q.query<{ template_id: string; settings: unknown }>('SELECT template_id, settings FROM label_templates WHERE merchant_id = $1 ORDER BY created_at', [merchantId]);
  const saved = rows.flatMap((r) => {
    const p = LabelTemplateInput.safeParse(r.settings);
    return p.success ? [{ template_id: r.template_id, settings: p.data }] : [];
  });
  // The built-in shelf tag is always there, first.
  return [{ template_id: null, settings: DEFAULT_LABEL_TEMPLATE }, ...saved];
}

export async function saveLabelTemplate(db: Db, actor: Actor, merchantId: string, templateId: string | null, t: LabelTemplateInput, traceId: string) {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    let id = templateId;
    if (id) {
      const { rows } = await q.query('UPDATE label_templates SET settings = $3, updated_at = now() WHERE template_id = $1 AND merchant_id = $2 RETURNING template_id', [id, merchantId, JSON.stringify(t)]);
      if (!rows[0]) throw notFound('Template not found');
    } else {
      const { rows } = await q.query<{ template_id: string }>('INSERT INTO label_templates (org_id, merchant_id, settings, created_by) VALUES ($1, $2, $3, $4) RETURNING template_id', [m.org_id, merchantId, JSON.stringify(t), actor.user_id]);
      id = rows[0]!.template_id;
    }
    await audit(q, { actor, action: templateId ? 'labels.template_updated' : 'labels.template_created', tenancy: m, target: id, details: t, trace_id: traceId });
    return { template_id: id };
  });
}

async function templateFor(q: Queryable, merchantId: string, templateId: string | null): Promise<LabelTemplateInput> {
  if (!templateId) return DEFAULT_LABEL_TEMPLATE;
  const t = (await labelTemplates(q, merchantId)).find((x) => x.template_id === templateId);
  if (!t) throw notFound('Template not found');
  return t.settings;
}

interface ItemRow {
  item_id: string;
  name: string;
  category: string | null;
  cash_price_cents: number;
  card_price_cents: number | null;
  upc: string | null;
  barcode: string | null;
}

async function itemsFor(q: Queryable, merchantId: string, itemIds: string[]): Promise<ItemRow[]> {
  const { rows } = await q.query<ItemRow>(
    `SELECT i.item_id, i.name, c.name AS category, i.cash_price_cents, i.card_price_cents, i.upc,
            (SELECT b.barcode FROM item_barcodes b WHERE b.item_id = i.item_id AND b.pack_qty = 1 ORDER BY b.created_at LIMIT 1) AS barcode
       FROM items i LEFT JOIN categories c ON c.category_id = i.category_id
      WHERE i.merchant_id = $1 AND i.item_id = ANY($2::uuid[])
      ORDER BY c.sort NULLS LAST, i.name`,
    [merchantId, itemIds],
  );
  if (rows.length !== new Set(itemIds).size) throw badRequest('Some of those items aren’t in this store’s catalog');
  return rows;
}

/** The next in-store UPC for this merchant (number system 4). */
async function nextInStoreUpc(q: Queryable, merchantId: string): Promise<string> {
  const { rows } = await q.query<{ n: string | null }>(
    `SELECT max(substr(barcode, 2, 10))::text AS n FROM item_barcodes WHERE merchant_id = $1 AND barcode ~ '^4[0-9]{11}$'`,
    [merchantId],
  );
  return inStoreUpc(Number(rows[0]?.n ?? '0') + 1);
}

/**
 * Tags for these items as a PDF, at this location's prices. Items without any barcode get an in-store
 * one first (when the template shows barcodes). Printing is recorded for the queue.
 */
export async function printShelfTags(
  db: Db,
  actor: Actor,
  merchantId: string,
  body: { item_ids: string[]; location_id: string; template_id: string | null; copies: number },
  traceId: string,
): Promise<Buffer> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const template = await templateFor(q, merchantId, body.template_id);
    const { rows: loc } = await q.query<{ dual_price_rate_ppm: number }>('SELECT dual_price_rate_ppm FROM locations WHERE location_id = $1 AND merchant_id = $2', [body.location_id, merchantId]);
    if (!loc[0]) throw notFound('Location not found');
    const items = await itemsFor(q, merchantId, body.item_ids);

    let assigned = 0;
    for (const it of items) {
      if (!template.show_barcode || it.upc || it.barcode) continue;
      it.barcode = await nextInStoreUpc(q, merchantId);
      await q.query('INSERT INTO item_barcodes (org_id, merchant_id, item_id, barcode, pack_qty) VALUES ($1, $2, $3, $4, 1)', [m.org_id, merchantId, it.item_id, it.barcode]);
      assigned++;
    }
    if (assigned) await bumpCatalogVersion(q, merchantId);

    const tags: TagContent[] = [];
    for (const it of items) {
      const price = resolveDualPrice(it, loc[0].dual_price_rate_ppm);
      const code = it.upc ?? it.barcode;
      const tag: TagItem = { name: it.name, category: it.category, cash_price_cents: price.cash, card_price_cents: price.card, barcode: code ? { kind: barcodeKind(code), data: code } : null };
      for (let c = 0; c < body.copies; c++) tags.push(tagContent(tag, template));
      await q.query(
        `INSERT INTO shelf_tag_prints (org_id, merchant_id, item_id, cash_price_cents, card_price_cents, printed_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (merchant_id, item_id) DO UPDATE SET cash_price_cents = EXCLUDED.cash_price_cents, card_price_cents = EXCLUDED.card_price_cents,
           printed_at = now(), printed_by = EXCLUDED.printed_by`,
        [m.org_id, merchantId, it.item_id, price.cash, price.card, actor.user_id],
      );
    }
    await audit(q, { actor, action: 'labels.shelf_tags_printed', tenancy: m, target: body.location_id, details: { items: items.length, copies: body.copies, barcodes_assigned: assigned, size: template.size }, trace_id: traceId });
    return labelsPdf(tags, template.size);
  });
}

/**
 * Tags to reprint: every active item whose tag was printed at a different price, and items whose
 * price changed in the last 14 days and never had a tag printed.
 */
export async function tagQueue(q: Queryable, merchantId: string, locationId: string) {
  const { rows: loc } = await q.query<{ dual_price_rate_ppm: number }>('SELECT dual_price_rate_ppm FROM locations WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId]);
  if (!loc[0]) throw notFound('Location not found');
  const { rows } = await q.query<{ item_id: string; name: string; cash_price_cents: number; card_price_cents: number | null; printed_cash: number | null; printed_card: number | null; printed_at: Date | null; changed: boolean }>(
    `SELECT i.item_id, i.name, i.cash_price_cents, i.card_price_cents, p.cash_price_cents AS printed_cash, p.card_price_cents AS printed_card, p.printed_at,
            EXISTS (SELECT 1 FROM item_price_history h WHERE h.item_id = i.item_id AND h.changed_at > now() - interval '14 days') AS changed
       FROM items i LEFT JOIN shelf_tag_prints p ON p.item_id = i.item_id AND p.merchant_id = i.merchant_id
      WHERE i.merchant_id = $1 AND i.active AND NOT i.open_price
      ORDER BY i.name`,
    [merchantId],
  );
  return {
    items: rows.flatMap((r) => {
      const now = resolveDualPrice(r, loc[0]!.dual_price_rate_ppm);
      const stale = r.printed_cash !== null ? r.printed_cash !== now.cash || r.printed_card !== now.card : r.changed;
      return stale
        ? [{ item_id: r.item_id, name: r.name, cash_price_cents: now.cash, card_price_cents: now.card, printed_cash_cents: r.printed_cash, printed_at: r.printed_at ? r.printed_at.toISOString() : null }]
        : [];
    }),
  };
}

/** Price labels for an open-price item (deli): the register rings each at the printed price. */
export async function printPriceLabels(db: Db, actor: Actor, merchantId: string, body: { item_id: string; location_id: string; price_cents: number; copies: number }, traceId: string): Promise<Buffer> {
  return db.tx(async (q) => {
    const m = await merchantFor(q, merchantId);
    const { rows } = await q.query<{ name: string; plu: string | null; open_price: boolean }>('SELECT name, plu, open_price FROM items WHERE item_id = $1 AND merchant_id = $2', [body.item_id, merchantId]);
    const it = rows[0];
    if (!it) throw notFound('Item not found');
    if (!it.open_price) throw badRequest('Price labels are for open-price items (the deli); other items print shelf tags');
    if (!it.plu || !/^\d{1,5}$/.test(it.plu)) throw badRequest('Give this item a PLU of up to 5 digits first; the label carries it');
    const { rows: loc } = await q.query<{ dual_price_rate_ppm: number }>('SELECT dual_price_rate_ppm FROM locations WHERE location_id = $1 AND merchant_id = $2', [body.location_id, merchantId]);
    if (!loc[0]) throw notFound('Location not found');
    const price = resolveDualPrice({ cash_price_cents: body.price_cents, card_price_cents: null }, loc[0].dual_price_rate_ppm);
    const code = priceEmbeddedUpc(it.plu, body.price_cents);
    const tag = tagContent(
      { name: it.name, category: null, cash_price_cents: price.cash, card_price_cents: price.card, barcode: { kind: 'upca', data: code } },
      { name: 'Price label', size: 'thermal_2x1', show_card_price: true, show_barcode: true, show_category: false, note: null },
    );
    await audit(q, { actor, action: 'labels.price_labels_printed', tenancy: m, target: body.item_id, details: { price_cents: body.price_cents, copies: body.copies }, trace_id: traceId });
    return labelsPdf(Array.from({ length: body.copies }, () => tag), 'thermal_2x1');
  });
}
