/**
 * Named key pages (ADR 0047): the owner's register tabs per store. A save replaces the store's pages
 * in one transaction, checks every key belongs to this merchant (an item, or a department with an
 * optional fixed amount), bumps the catalog version so registers pick them up, and is audited.
 */
import type { KeyPage, KeyPagesInputT, PageKey } from '@adpay/shared';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion, type CatalogActor } from './catalog-write';

export async function keyPagesFor(q: Queryable, locationId: string): Promise<KeyPage[]> {
  const { rows } = await q.query<{ page_id: string; name: string; keys: PageKey[] }>(
    'SELECT page_id, name, keys FROM key_pages WHERE location_id = $1 ORDER BY sort',
    [locationId],
  );
  return rows;
}

export async function setKeyPages(
  db: Db,
  actor: CatalogActor,
  merchantId: string,
  locationId: string,
  input: KeyPagesInputT,
  traceId: string,
): Promise<{ location_id: string; pages: KeyPage[]; catalog_version: number }> {
  return db.tx(async (q) => {
    const { rows: locs } = await q.query<{ org_id: string }>('SELECT org_id FROM locations WHERE location_id = $1 AND merchant_id = $2 FOR UPDATE', [locationId, merchantId]);
    const loc = locs[0];
    if (!loc) throw notFound('Location not found');

    const keys = input.pages.flatMap((p) => p.keys);
    const itemIds = [...new Set(keys.flatMap((k) => (k.kind === 'item' ? [k.item_id] : [])))];
    const categoryIds = [...new Set(keys.flatMap((k) => (k.kind === 'department' ? [k.category_id] : [])))];
    if (itemIds.length) {
      const { rows } = await q.query('SELECT 1 FROM items WHERE merchant_id = $1 AND item_id = ANY($2::uuid[])', [merchantId, itemIds]);
      if (rows.length !== itemIds.length) throw badRequest('Every key must be an item in this catalog');
    }
    if (categoryIds.length) {
      const { rows } = await q.query('SELECT 1 FROM categories WHERE merchant_id = $1 AND category_id = ANY($2::uuid[])', [merchantId, categoryIds]);
      if (rows.length !== categoryIds.length) throw badRequest('Every department key must be one of this catalog\'s departments');
    }

    const before = await keyPagesFor(q, locationId);
    await q.query('DELETE FROM key_pages WHERE location_id = $1', [locationId]);
    for (const [sort, p] of input.pages.entries()) {
      await q.query('INSERT INTO key_pages (org_id, merchant_id, location_id, name, sort, keys) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [
        loc.org_id, merchantId, locationId, p.name, sort, JSON.stringify(p.keys),
      ]);
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'location.key_pages_set',
      tenancy: { org_id: loc.org_id, merchant_id: merchantId, location_id: locationId },
      target: locationId,
      details: { from: before.map((p) => ({ name: p.name, keys: p.keys.length })), to: input.pages.map((p) => ({ name: p.name, keys: p.keys.length })), catalog_version: version },
      trace_id: traceId,
    });
    return { location_id: locationId, pages: await keyPagesFor(q, locationId), catalog_version: version };
  });
}
