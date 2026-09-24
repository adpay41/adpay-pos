/**
 * Lottery module (build plan P17, ADR 0027): games, packs and bins per location; daily bin counts
 * (append-only); the state terminal's daily report typed in; and the day's reconciliation against
 * what was rung at the register and paid out of the drawer. Every write is audited.
 */
import {
  RegisterEventSchema,
  foldSale,
  lineTotal,
  reconcileDay,
  ticketsSold,
  type LotteryDay,
  type LotteryGame,
  type LotteryPack,
  type PackStatus,
  type RegisterEvent,
} from '@adpay/shared';
import type { z } from 'zod';
import type { LotteryCountInput, LotteryGameInput, PackActivateInput, PackReceiveInput, TerminalReportInput } from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';

type Actor = MerchantUserPrincipal | AdminPrincipal;

async function location(q: Queryable, merchantId: string, locationId: string) {
  const { rows } = await q.query<{ org_id: string; merchant_id: string; location_id: string }>('SELECT org_id, merchant_id, location_id FROM locations WHERE location_id = $1 AND merchant_id = $2', [locationId, merchantId]);
  if (!rows[0]) throw notFound('Location not found');
  return rows[0];
}

export async function games(q: Queryable, merchantId: string, locationId: string): Promise<LotteryGame[]> {
  await location(q, merchantId, locationId); // another merchant's location is a 404, not an empty list
  const { rows } = await q.query<LotteryGame>(
    'SELECT game_id, game_number, name, price_cents::int AS price_cents, tickets_per_pack, active FROM lottery_games WHERE merchant_id = $1 AND location_id = $2 ORDER BY price_cents, game_number',
    [merchantId, locationId],
  );
  return rows;
}

export async function addGame(db: Db, actor: Actor, merchantId: string, locationId: string, g: z.infer<typeof LotteryGameInput>, traceId: string): Promise<{ game_id: string }> {
  return db.tx(async (q) => {
    const t = await location(q, merchantId, locationId);
    const { rows } = await q.query<{ game_id: string }>(
      `INSERT INTO lottery_games (org_id, merchant_id, location_id, game_number, name, price_cents, tickets_per_pack) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (location_id, game_number) DO NOTHING RETURNING game_id`,
      [t.org_id, merchantId, locationId, g.game_number, g.name, g.price_cents, g.tickets_per_pack],
    );
    if (!rows[0]) throw badRequest(`Game ${g.game_number} is already set up here`);
    await audit(q, { actor, action: 'lottery.game_added', tenancy: t, target: rows[0].game_id, details: g, trace_id: traceId });
    return rows[0];
  });
}

const PACK_SELECT = `SELECT p.pack_id, p.game_id, g.game_number, g.name AS game_name, g.price_cents::int AS price_cents, g.tickets_per_pack, p.pack_number, p.status, p.bin,
                            p.start_ticket, p.received_at, p.activated_at, p.closed_at
                       FROM lottery_packs p JOIN lottery_games g ON g.game_id = p.game_id`;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function packs(q: Queryable, merchantId: string, locationId: string, statuses: PackStatus[] = ['received', 'active']): Promise<LotteryPack[]> {
  const { rows } = await q.query<LotteryPack>(`${PACK_SELECT} WHERE p.merchant_id = $1 AND p.location_id = $2 AND p.status = ANY($3::text[]) ORDER BY p.status, p.bin NULLS LAST, g.game_number, p.pack_number`, [
    merchantId,
    locationId,
    statuses,
  ]);
  return rows.map((r) => ({ ...r, received_at: iso(r.received_at)!, activated_at: iso(r.activated_at), closed_at: iso(r.closed_at) }));
}

export async function receivePack(db: Db, actor: Actor, merchantId: string, locationId: string, p: z.infer<typeof PackReceiveInput>, traceId: string): Promise<{ pack_id: string }> {
  return db.tx(async (q) => {
    const t = await location(q, merchantId, locationId);
    const { rows: g } = await q.query('SELECT 1 FROM lottery_games WHERE game_id = $1 AND location_id = $2', [p.game_id, locationId]);
    if (!g[0]) throw badRequest('That game isn’t set up at this store');
    const { rows } = await q.query<{ pack_id: string }>(
      `INSERT INTO lottery_packs (org_id, merchant_id, location_id, game_id, pack_number, received_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (game_id, pack_number) DO NOTHING RETURNING pack_id`,
      [t.org_id, merchantId, locationId, p.game_id, p.pack_number, actor.user_id],
    );
    if (!rows[0]) throw badRequest(`Pack ${p.pack_number} of that game was already received`);
    await audit(q, { actor, action: 'lottery.pack_received', tenancy: t, target: rows[0].pack_id, details: p, trace_id: traceId });
    return rows[0];
  });
}

/** Move a pack along: activate into a bin, mark sold out, or return it. Checked transitions only. */
export async function updatePack(
  db: Db,
  actor: Actor,
  merchantId: string,
  packId: string,
  change: { to: 'active'; bin: number; start_ticket: number } | { to: 'sold_out' | 'returned' },
  traceId: string,
): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; location_id: string; status: PackStatus }>('SELECT org_id, location_id, status FROM lottery_packs WHERE pack_id = $1 AND merchant_id = $2 FOR UPDATE', [packId, merchantId]);
    const p = rows[0];
    if (!p) throw notFound('Pack not found');
    const allowed: Record<string, PackStatus[]> = { active: ['received'], sold_out: ['active'], returned: ['received', 'active'] };
    if (!allowed[change.to]!.includes(p.status)) throw badRequest(`A ${p.status.replace('_', ' ')} pack can’t become ${change.to.replace('_', ' ')}`);
    if (change.to === 'active') {
      const { rows: taken } = await q.query('SELECT 1 FROM lottery_packs WHERE location_id = $1 AND bin = $2 AND status = \'active\'', [p.location_id, change.bin]);
      if (taken[0]) throw badRequest(`Bin ${change.bin} already has an active pack. Mark it sold out first.`);
      await q.query('UPDATE lottery_packs SET status = \'active\', bin = $2, start_ticket = $3, activated_at = now(), activated_by = $4 WHERE pack_id = $1', [packId, change.bin, change.start_ticket, actor.user_id]);
    } else {
      await q.query('UPDATE lottery_packs SET status = $2, closed_at = now() WHERE pack_id = $1', [packId, change.to]);
    }
    await audit(q, { actor, action: `lottery.pack_${change.to}`, tenancy: { org_id: p.org_id, merchant_id: merchantId, location_id: p.location_id }, target: packId, details: change, trace_id: traceId });
  });
}

export async function recordCount(db: Db, actor: Actor, merchantId: string, locationId: string, c: z.infer<typeof LotteryCountInput>, traceId: string): Promise<{ count_id: string }> {
  return db.tx(async (q) => {
    const t = await location(q, merchantId, locationId);
    const ids = c.entries.map((e) => e.pack_id);
    const { rows: known } = await q.query<{ pack_id: string; tickets_per_pack: number }>(
      `SELECT p.pack_id, g.tickets_per_pack FROM lottery_packs p JOIN lottery_games g ON g.game_id = p.game_id WHERE p.location_id = $1 AND p.status = 'active' AND p.pack_id = ANY($2::uuid[])`,
      [locationId, ids],
    );
    if (known.length !== new Set(ids).size) throw badRequest('Count only the active packs in this store’s bins');
    const size = new Map(known.map((k) => [k.pack_id, k.tickets_per_pack]));
    for (const e of c.entries) if (e.next_ticket > size.get(e.pack_id)!) throw badRequest('A ticket number is past the end of its pack');
    const { rows } = await q.query<{ count_id: string }>(
      'INSERT INTO lottery_counts (org_id, merchant_id, location_id, business_date, entries, counted_by, trace_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING count_id',
      [t.org_id, merchantId, locationId, c.business_date, JSON.stringify(c.entries), actor.user_id, traceId],
    );
    // A pack counted as sold out leaves its bin.
    const out = c.entries.filter((e) => e.sold_out).map((e) => e.pack_id);
    if (out.length) await q.query(`UPDATE lottery_packs SET status = 'sold_out', closed_at = now() WHERE pack_id = ANY($1::uuid[])`, [out]);
    await audit(q, { actor, action: 'lottery.counted', tenancy: t, target: rows[0]!.count_id, details: { business_date: c.business_date, packs: c.entries.length, sold_out: out.length }, trace_id: traceId });
    return rows[0]!;
  });
}

export async function setTerminalReport(db: Db, actor: Actor, merchantId: string, locationId: string, r: z.infer<typeof TerminalReportInput>, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const t = await location(q, merchantId, locationId);
    await q.query(
      `INSERT INTO lottery_terminal_reports (org_id, merchant_id, location_id, business_date, online_sales_cents, cashes_cents, instant_sales_cents, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (location_id, business_date) DO UPDATE SET online_sales_cents = EXCLUDED.online_sales_cents, cashes_cents = EXCLUDED.cashes_cents,
         instant_sales_cents = EXCLUDED.instant_sales_cents, entered_by = EXCLUDED.entered_by, entered_at = now()`,
      [t.org_id, merchantId, locationId, r.business_date, r.online_sales_cents, r.cashes_cents, r.instant_sales_cents, actor.user_id],
    );
    await audit(q, { actor, action: 'lottery.terminal_report_set', tenancy: t, target: locationId, details: r, trace_id: traceId });
  });
}

/** One day's lottery at one location, reconciled. */
export async function lotteryDay(q: Queryable, merchantId: string, locationId: string, date: string): Promise<LotteryDay> {
  await location(q, merchantId, locationId);
  // Instant sold: each pack's last reading of the day against its previous reading (or its start).
  const { rows: counts } = await q.query<{ business_date: string; entries: { pack_id: string; next_ticket: number; sold_out: boolean }[] }>(
    `SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date, entries FROM lottery_counts WHERE location_id = $1 AND business_date <= $2::date ORDER BY business_date, created_at`,
    [locationId, date],
  );
  const { rows: packRows } = await q.query<{ pack_id: string; start_ticket: number; tickets_per_pack: number; price_cents: number; game_number: string; game_name: string }>(
    `SELECT p.pack_id, p.start_ticket, g.tickets_per_pack, g.price_cents::int AS price_cents, g.game_number, g.name AS game_name
       FROM lottery_packs p JOIN lottery_games g ON g.game_id = p.game_id WHERE p.location_id = $1`,
    [locationId],
  );
  const packInfo = new Map(packRows.map((p) => [p.pack_id, p]));
  const before = new Map<string, number>(); // last reading before `date`
  const today = new Map<string, { next_ticket: number; sold_out: boolean }>();
  for (const c of counts) {
    for (const e of c.entries) {
      if (c.business_date < date) before.set(e.pack_id, e.sold_out ? (packInfo.get(e.pack_id)?.tickets_per_pack ?? e.next_ticket) : e.next_ticket);
      else today.set(e.pack_id, e);
    }
  }
  const byGame = new Map<string, { game_number: string; game_name: string; tickets: number; amount_cents: number }>();
  for (const [packId, now] of today) {
    const p = packInfo.get(packId);
    if (!p) continue;
    const sold = ticketsSold(before.get(packId) ?? p.start_ticket, now, p.tickets_per_pack);
    const g = byGame.get(p.game_number) ?? { game_number: p.game_number, game_name: p.game_name, tickets: 0, amount_cents: 0 };
    g.tickets += sold;
    g.amount_cents += sold * p.price_cents;
    byGame.set(p.game_number, g);
  }

  // Rung at the register: lottery-restricted lines on sales completed that day, at the price paid.
  const { rows: evRows } = await q.query<Record<string, unknown> & { occurred_at: Date }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id, e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload
       FROM sale_events e
      WHERE e.sale_id IN (SELECT x.sale_id FROM sale_events x WHERE x.location_id = $1 AND x.type = 'sale.completed' AND x.business_date = $2::date)
        AND e.sale_id IN (SELECT y.sale_id FROM sale_events y WHERE y.location_id = $1 AND y.type = 'sale.line_added' AND y.payload->>'restriction' = 'lottery')
      ORDER BY e.sale_id, e.device_seq`,
    [locationId, date],
  );
  const bySale = new Map<string, RegisterEvent[]>();
  const lotteryLines = new Set<string>();
  for (const r of evRows) {
    const e = RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() });
    bySale.set(e.sale_id!, [...(bySale.get(e.sale_id!) ?? []), e]);
    if (e.type === 'sale.line_added' && e.payload.restriction === 'lottery') lotteryLines.add(e.payload.line_id);
  }
  let rung = 0;
  for (const [id, events] of bySale) {
    const s = foldSale(id, events);
    if (s.status !== 'completed') continue;
    for (const l of s.lines) if (lotteryLines.has(l.line_id)) rung += lineTotal(l, s.price_mode === 'card' ? 'card' : 'cash');
  }

  const { rows: payouts } = await q.query<{ n: string | null }>(
    `SELECT sum((payload->>'amount_cents')::bigint) AS n FROM sale_events
      WHERE location_id = $1 AND business_date = $2::date AND type = 'drawer.cash_movement'
        AND payload->>'kind' = 'paid_out' AND payload->>'reason' ILIKE '%lottery%'`,
    [locationId, date],
  );
  const { rows: term } = await q.query<{ online_sales_cents: string; cashes_cents: string; instant_sales_cents: string | null }>(
    'SELECT online_sales_cents, cashes_cents, instant_sales_cents FROM lottery_terminal_reports WHERE location_id = $1 AND business_date = $2::date',
    [locationId, date],
  );
  return reconcileDay({
    business_date: date,
    instant: [...byGame.values()].sort((a, b) => a.game_number.localeCompare(b.game_number)),
    rung_cents: rung,
    drawer_payouts_cents: Number(payouts[0]?.n ?? 0),
    terminal: term[0] ? { online_sales_cents: Number(term[0].online_sales_cents), cashes_cents: Number(term[0].cashes_cents), instant_sales_cents: term[0].instant_sales_cents === null ? null : Number(term[0].instant_sales_cents) } : null,
    counted: today.size > 0,
  });
}
