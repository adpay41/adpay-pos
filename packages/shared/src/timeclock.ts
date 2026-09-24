/**
 * Time clock (build plan P15, Bible 1.8 / 2.5): clock in and out at the register, hours to the
 * merchant app, overtime flags, a payroll export. ADR 0024.
 *
 * Shifts are folded from `staff.clocked_in` / `staff.clocked_out` events, like everything else:
 * nothing is typed into a timesheet. A second clock-in without a clock-out closes nothing (the open
 * shift stays open); a clock-out with no open shift is ignored. Minutes are integers.
 */
import type { RegisterEvent } from './events';

export interface Shift {
  user_id: string;
  register_id: string;
  in_at: string;
  out_at: string | null;
  /** Whole minutes on the clock (to `now` for an open shift). */
  minutes: number;
}

/** Federal FLSA overtime is weekly: over 40 hours. NY and NJ follow the weekly rule for most retail. */
export const OVERTIME_WEEKLY_MINUTES = 40 * 60;

export function foldShifts(events: readonly RegisterEvent[], now: Date = new Date()): Shift[] {
  const ordered = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.device_seq - b.device_seq);
  const open = new Map<string, { register_id: string; in_at: string }>();
  const shifts: Shift[] = [];
  const minutes = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000));
  for (const e of ordered) {
    if (e.type === 'staff.clocked_in') {
      if (!open.has(e.payload.user_id)) open.set(e.payload.user_id, { register_id: e.register_id, in_at: e.occurred_at });
    } else if (e.type === 'staff.clocked_out') {
      const o = open.get(e.payload.user_id);
      if (!o) continue;
      shifts.push({ user_id: e.payload.user_id, register_id: o.register_id, in_at: o.in_at, out_at: e.occurred_at, minutes: minutes(o.in_at, e.occurred_at) });
      open.delete(e.payload.user_id);
    }
  }
  for (const [user_id, o] of open) shifts.push({ user_id, register_id: o.register_id, in_at: o.in_at, out_at: null, minutes: minutes(o.in_at, now.toISOString()) });
  return shifts.sort((a, b) => a.in_at.localeCompare(b.in_at));
}

/** Who is on the clock right now, from the same events. */
export function clockedIn(events: readonly RegisterEvent[]): Set<string> {
  return new Set(foldShifts(events).filter((s) => s.out_at === null).map((s) => s.user_id));
}

export interface TimesheetRow {
  user_id: string;
  name: string;
  /** Minutes per store-local day, YYYY-MM-DD → minutes. */
  by_day: Record<string, number>;
  total_minutes: number;
  overtime_minutes: number;
  open_shift: boolean;
}

export interface Timesheet {
  from: string;
  to: string;
  rows: TimesheetRow[];
  shifts: (Shift & { name: string; register_name: string })[];
}

/** "7:05" from minutes. */
export function hhmm(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Payroll export: one line per person with daily hours, total, overtime; plain CSV any payroll tool reads. */
export function timesheetCsv(t: Timesheet): string {
  const days: string[] = [];
  for (let d = new Date(`${t.from}T12:00:00Z`); d.toISOString().slice(0, 10) <= t.to; d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['Employee', ...days, 'Total hours', 'Overtime hours'].join(',')];
  for (const r of t.rows) lines.push([q(r.name), ...days.map((d) => hhmm(r.by_day[d] ?? 0)), hhmm(r.total_minutes), hhmm(r.overtime_minutes)].join(','));
  return lines.join('\n') + '\n';
}
