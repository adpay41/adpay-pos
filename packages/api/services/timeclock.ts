/**
 * Timesheets from the time clock (build plan P15, Bible 1.8 / 2.5, ADR 0024). Shifts are folded from
 * `staff.clocked_in` / `staff.clocked_out` events; a shift counts on the store-local day it started.
 * Overtime is weekly (Monday–Sunday, over 40 hours), per the federal rule NJ/NY retail follows.
 */
import { OVERTIME_WEEKLY_MINUTES, RegisterEventSchema, foldShifts, localDate, type RegisterEvent, type Timesheet } from '@adpay/shared';
import type { Queryable } from '../db/db';

/** Monday of the week containing a YYYY-MM-DD date. */
function weekOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

export async function timesheet(q: Queryable, merchantId: string, from: string, to: string, now = new Date()): Promise<Timesheet> {
  // Read from the Monday of the first week, so overtime counts the whole week, and a day before it
  // so a shift that started the night before is paired with its clock-out.
  const readFrom = new Date(Date.parse(`${weekOf(from)}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const { rows } = await q.query<Record<string, unknown> & { occurred_at: Date | string }>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.org_id, e.merchant_id, e.location_id,
            e.register_id, e.trace_id, e.actor_user_id, e.type, e.payload
       FROM sale_events e
      WHERE e.merchant_id = $1 AND e.type IN ('staff.clocked_in', 'staff.clocked_out')
        AND e.business_date BETWEEN $2::date AND $3::date + 1
      ORDER BY e.occurred_at`,
    [merchantId, readFrom, to],
  );
  const events: RegisterEvent[] = rows.map((r) => RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() }));
  const { rows: tz } = await q.query<{ timezone: string }>('SELECT timezone FROM locations WHERE merchant_id = $1 ORDER BY created_at LIMIT 1', [merchantId]);
  const zone = tz[0]?.timezone ?? 'America/New_York';
  const all = foldShifts(events, now).map((s) => ({ ...s, day: localDate(s.in_at, zone) }));

  const userIds = [...new Set(all.map((s) => s.user_id))];
  const regIds = [...new Set(all.map((s) => s.register_id))];
  const names = new Map((await q.query<{ user_id: string; name: string }>('SELECT user_id, name FROM users WHERE user_id = ANY($1::uuid[])', [userIds])).rows.map((u) => [u.user_id, u.name]));
  const regs = new Map((await q.query<{ register_id: string; name: string }>('SELECT register_id, name FROM registers WHERE register_id = ANY($1::uuid[])', [regIds])).rows.map((r) => [r.register_id, r.name]));

  const rowsOut = userIds.map((user_id) => {
    const mine = all.filter((s) => s.user_id === user_id);
    const inRange = mine.filter((s) => s.day >= from && s.day <= to);
    const by_day: Record<string, number> = {};
    for (const s of inRange) by_day[s.day] = (by_day[s.day] ?? 0) + s.minutes;
    // Overtime per week, counting the whole week; attributed to the range as far as it overlaps.
    const weeks = new Map<string, number>();
    for (const s of mine) weeks.set(weekOf(s.day), (weeks.get(weekOf(s.day)) ?? 0) + s.minutes);
    const overtime = [...weeks.entries()].filter(([w]) => w <= to && w >= weekOf(from)).reduce((n, [, m]) => n + Math.max(0, m - OVERTIME_WEEKLY_MINUTES), 0);
    return {
      user_id,
      name: names.get(user_id) ?? 'Unknown',
      by_day,
      total_minutes: inRange.reduce((n, s) => n + s.minutes, 0),
      overtime_minutes: overtime,
      open_shift: mine.some((s) => s.out_at === null),
    };
  });
  return {
    from,
    to,
    rows: rowsOut.filter((r) => r.total_minutes > 0 || r.open_shift).sort((a, b) => a.name.localeCompare(b.name)),
    shifts: all
      .filter((s) => s.day >= from && s.day <= to)
      .map(({ day: _day, ...s }) => ({ ...s, name: names.get(s.user_id) ?? 'Unknown', register_name: regs.get(s.register_id) ?? 'Register' })),
  };
}
