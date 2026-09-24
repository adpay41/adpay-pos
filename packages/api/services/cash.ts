/**
 * Cash drawer reports (build plan P6, Bible 1.2 / 2.4 shrink): every session, what it should have
 * held, what was counted, over/short by cashier and by day. Folded at read time from the same
 * events and the same shared `foldDrawer` the register uses, so the two can never disagree.
 */
import { AlertSettingsInput, DEFAULT_ALERT_SETTINGS, RegisterEventSchema, dropSuggestion, foldDrawer, overShortByCashier, sum, cents, type CashReport, type CashSessionRow, type DrawerSession, type RegisterEvent } from '@adpay/shared';
import type { Queryable } from '../db/db';

const CASH_TYPES = ['drawer.session_opened', 'drawer.cash_movement', 'drawer.session_closed', 'drawer.opened', 'drawer.counterfeit', 'sale.tender_added', 'sale.refunded'];

interface Row {
  event_id: string;
  schema_version: number;
  sale_id: string | null;
  device_seq: number;
  occurred_at: Date | string;
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
  trace_id: string;
  actor_user_id: string | null;
  type: string;
  payload: unknown;
  business_date: string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

/**
 * Drawer sessions per register from the cash-relevant events since `fromDate` (a business date).
 * `merchantId` null = every merchant (the alert rules). Returns each session with the business
 * date of its opening event.
 */
export async function drawerSessions(
  q: Queryable,
  merchantId: string | null,
  fromDate: string,
  locationId: string | null = null,
): Promise<(DrawerSession & { business_date: string; merchant_id: string; location_id: string })[]> {
  const { rows } = await q.query<Row>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id,
            e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload, to_char(e.business_date, 'YYYY-MM-DD') AS business_date
       FROM sale_events e
      WHERE ($1::uuid IS NULL OR e.merchant_id = $1) AND e.business_date >= $2::date AND e.type = ANY($3::text[])
        AND ($4::uuid IS NULL OR e.location_id = $4)
      ORDER BY e.register_id, e.device_seq`,
    [merchantId, fromDate, CASH_TYPES, locationId],
  );
  interface Group {
    events: RegisterEvent[];
    openedDate: Map<string, string>;
    merchant: string;
    location: string;
  }
  const byRegister = new Map<string, Group>();
  for (const r of rows) {
    const g: Group = byRegister.get(r.register_id) ?? { events: [], openedDate: new Map(), merchant: r.merchant_id, location: r.location_id };
    const { business_date: _date, ...envelope } = r;
    const e = RegisterEventSchema.parse({ ...envelope, occurred_at: iso(r.occurred_at) });
    g.events.push(e);
    if (e.type === 'drawer.session_opened') g.openedDate.set(e.payload.session_id, r.business_date);
    byRegister.set(r.register_id, g);
  }
  const out: (DrawerSession & { business_date: string; merchant_id: string; location_id: string })[] = [];
  for (const g of byRegister.values()) {
    for (const s of foldDrawer(g.events).sessions) {
      // A session whose opening fell before the window was cut off; only report whole sessions.
      const d = g.openedDate.get(s.session_id);
      if (d) out.push({ ...s, business_date: d, merchant_id: g.merchant, location_id: g.location });
    }
  }
  return out.sort((a, b) => b.opened_at.localeCompare(a.opened_at));
}

export async function cashReport(q: Queryable, merchantId: string, range: CashReport['range'], locationId: string | null = null): Promise<CashReport> {
  const { rows: win } = await q.query<{ d_from: string; d_to: string }>(
    `WITH t AS (
       SELECT (now() AT TIME ZONE coalesce(
         (SELECT timezone FROM locations WHERE merchant_id = $1 ORDER BY created_at LIMIT 1), 'America/New_York'))::date AS today)
     SELECT to_char(CASE $2::text WHEN 'today' THEN today WHEN 'week' THEN today - 6 ELSE date_trunc('month', today)::date END, 'YYYY-MM-DD') AS d_from,
            to_char(today, 'YYYY-MM-DD') AS d_to
       FROM t`,
    [merchantId, range],
  );
  const { d_from, d_to } = win[0]!;
  const sessions = (await drawerSessions(q, merchantId, d_from, locationId)).filter((s) => s.business_date <= d_to);
  // Cash in each drawer right now, looking back a week so a session opened last night still counts.
  const weekAgo = new Date(Date.parse(`${d_to}T12:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const openNow = (await drawerSessions(q, merchantId, weekAgo, locationId)).filter((s) => s.closed_at === null);
  const { rows: settingsRow } = await q.query<{ alert_settings: unknown }>('SELECT alert_settings FROM merchants WHERE merchant_id = $1', [merchantId]);
  const dropOver = (AlertSettingsInput.safeParse(settingsRow[0]?.alert_settings ?? {}).data ?? DEFAULT_ALERT_SETTINGS).drop_over_cents;

  const regIds = [...new Set([...sessions, ...openNow].map((s) => s.register_id))];
  const userIds = [...new Set(sessions.flatMap((s) => [s.opened_by, s.closed_by]).filter((x): x is string => !!x))];
  const regs = new Map(
    (
      await q.query<{ register_id: string; register_name: string; location_name: string }>(
        `SELECT r.register_id, r.name AS register_name, l.name AS location_name FROM registers r JOIN locations l USING (location_id)
          WHERE r.register_id = ANY($1::uuid[])`,
        [regIds],
      )
    ).rows.map((r) => [r.register_id, r]),
  );
  const names = new Map((await q.query<{ user_id: string; name: string }>('SELECT user_id, name FROM users WHERE user_id = ANY($1::uuid[])', [userIds])).rows.map((u) => [u.user_id, u.name]));

  const rows: CashSessionRow[] = sessions.map((s) => ({
    ...s,
    register_name: regs.get(s.register_id)?.register_name ?? 'Register',
    location_name: regs.get(s.register_id)?.location_name ?? '',
    opened_by_name: s.opened_by ? (names.get(s.opened_by) ?? null) : null,
    closed_by_name: s.closed_by ? (names.get(s.closed_by) ?? null) : null,
  }));
  const closed = rows.filter((s) => s.over_short_cents !== null);
  const days = new Map<string, CashSessionRow[]>();
  for (const s of closed) days.set(s.business_date, [...(days.get(s.business_date) ?? []), s]);

  return {
    range,
    from: d_from,
    to: d_to,
    sessions: rows,
    by_cashier: overShortByCashier(closed).map((c) => ({ ...c, name: c.user_id ? (names.get(c.user_id) ?? null) : null })),
    by_day: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ss]) => ({ date, sessions: ss.length, over_short_cents: sum(ss.map((s) => s.over_short_cents!)) })),
    totals: {
      drops_cents: sum(rows.map((s) => s.drops_cents)),
      paid_out_cents: sum(rows.map((s) => s.paid_out_cents)),
      paid_in_cents: sum(rows.map((s) => s.paid_in_cents)),
      over_short_cents: sum(closed.map((s) => cents(s.over_short_cents!))),
      no_sale_opens: rows.reduce((n, s) => n + s.no_sale_opens, 0),
      counterfeits: rows.reduce((n, s) => n + s.counterfeits.length, 0),
    },
    open_now: openNow.map((s) => ({
      session_id: s.session_id,
      register_id: s.register_id,
      register_name: regs.get(s.register_id)?.register_name ?? 'Register',
      location_name: regs.get(s.register_id)?.location_name ?? '',
      opened_at: s.opened_at,
      expected_cents: s.expected_cents,
      ...(({ needed, suggest_cents }) => ({ drop_needed: needed, suggest_cents }))(dropSuggestion(s.expected_cents, s.float_cents, dropOver)),
    })),
    drop_over_cents: dropOver,
  };
}
