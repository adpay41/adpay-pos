/**
 * Opening and closing checklists (Bible 2.8; P24c, ADR 0038). The lists are merchant config that
 * reaches registers in the snapshot; a change bumps the catalog version. What was ticked is the
 * register's `checklist.completed` event, read back here, never stored twice.
 */
import { checklistsOf, checklistSummary, type ChecklistKind, type ChecklistResultItem, type Checklists, type ChecklistSummary } from '@adpay/shared';
import type { MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';
import { mediaUrl } from './media';

export async function getChecklists(q: Queryable, merchantId: string): Promise<{ lists: Checklists; custom: boolean }> {
  const { rows } = await q.query<{ checklists: unknown }>('SELECT checklists FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  return { lists: checklistsOf(rows[0].checklists), custom: rows[0].checklists !== null };
}

export async function setChecklists(db: Db, actor: MerchantUserPrincipal, lists: Checklists, traceId: string): Promise<{ lists: Checklists; custom: boolean }> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; checklists: unknown }>('SELECT org_id, checklists FROM merchants WHERE merchant_id = $1 FOR UPDATE', [actor.merchant_id]);
    if (!rows[0]) throw notFound('Merchant not found');
    await q.query('UPDATE merchants SET checklists = $2 WHERE merchant_id = $1', [actor.merchant_id, JSON.stringify(lists)]);
    const version = await bumpCatalogVersion(q, actor.merchant_id);
    await audit(q, {
      actor,
      action: 'merchant.checklists_set',
      tenancy: { org_id: rows[0].org_id, merchant_id: actor.merchant_id },
      details: { open: lists.open.length, close: lists.close.length, catalog_version: version },
      trace_id: traceId,
    });
  });
  return getChecklists(db, actor.merchant_id);
}

export interface ChecklistRun {
  event_id: string;
  kind: ChecklistKind;
  location_id: string;
  location_name: string;
  register_name: string;
  business_date: string;
  at: string;
  by: string | null;
  items: (ChecklistResultItem & { photo_url: string | null })[];
  note: string | null;
  summary: ChecklistSummary;
}

export interface ChecklistDay {
  location_id: string;
  location_name: string;
  business_date: string;
  open: ChecklistRun | null;
  close: ChecklistRun | null;
}

/**
 * Every run in the range, and per store per day which of open / close happened (the latest run of
 * each counts; earlier ones stay in `runs`). Days are store-local business dates.
 */
export async function checklistReport(q: Queryable, merchantId: string, from: string, to: string): Promise<{ from: string; to: string; days: ChecklistDay[]; runs: ChecklistRun[] }> {
  const { rows } = await q.query<{
    event_id: string;
    location_id: string;
    location_name: string;
    register_name: string;
    business_date: string;
    occurred_at: Date;
    by: string | null;
    payload: { kind: ChecklistKind; items: ChecklistResultItem[]; note: string | null };
  }>(
    `SELECT e.event_id, e.location_id, l.name AS location_name, r.name AS register_name, to_char(e.business_date, 'YYYY-MM-DD') AS business_date,
            e.occurred_at, u.name AS by, e.payload
       FROM sale_events e
       JOIN locations l ON l.location_id = e.location_id
       JOIN registers r ON r.register_id = e.register_id
       LEFT JOIN users u ON u.user_id = e.actor_user_id
      WHERE e.merchant_id = $1 AND e.type = 'checklist.completed' AND e.business_date BETWEEN $2::date AND $3::date
      ORDER BY e.occurred_at`,
    [merchantId, from, to],
  );
  const runs: ChecklistRun[] = rows.map((r) => ({
    event_id: r.event_id,
    kind: r.payload.kind,
    location_id: r.location_id,
    location_name: r.location_name,
    register_name: r.register_name,
    business_date: r.business_date,
    at: r.occurred_at.toISOString(),
    by: r.by,
    items: r.payload.items.map((i) => ({ ...i, photo_url: i.photo_media_id ? mediaUrl(i.photo_media_id) : null })),
    note: r.payload.note,
    summary: checklistSummary(r.payload.items),
  }));

  // Every store × day in the range, so a day with nothing done shows as missing.
  const { rows: locs } = await q.query<{ location_id: string; name: string }>('SELECT location_id, name FROM locations WHERE merchant_id = $1 ORDER BY name', [merchantId]);
  const { rows: dates } = await q.query<{ d: string }>("SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series($1::date, $2::date, '1 day') d ORDER BY d DESC", [from, to]);
  const days: ChecklistDay[] = [];
  for (const { d } of dates) {
    for (const l of locs) {
      const mine = runs.filter((r) => r.location_id === l.location_id && r.business_date === d);
      days.push({
        location_id: l.location_id,
        location_name: l.name,
        business_date: d,
        open: mine.filter((r) => r.kind === 'open').at(-1) ?? null,
        close: mine.filter((r) => r.kind === 'close').at(-1) ?? null,
      });
    }
  }
  return { from, to, days, runs: runs.reverse() };
}
