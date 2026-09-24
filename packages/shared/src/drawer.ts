/**
 * Cash drawer accounting (build plan P6, Bible 1.2: "half the sales, all of the shrink").
 *
 * A drawer session runs from the starting-float count to the closing count on one register. What
 * the drawer should hold is **derived from events**, never typed or edited:
 *
 *   expected = float + cash taken on sales − cash refunded + paid-ins − paid-outs − drops
 *
 * The closing count is **blind**: the cashier counts and enters the total before seeing what was
 * expected. Over/short is then fixed in the close event, by the fold that computed it.
 */
import type { RegisterEvent } from './events';
import { add, cents, sub, sum, ZERO, type Cents } from './money';

export const CASH_MOVEMENT_KINDS = {
  drop: { label: 'Safe drop', sign: -1, hint: 'Cash from the drawer into the safe' },
  paid_out: { label: 'Paid out', sign: -1, hint: 'Cash paid from the drawer, e.g. a vendor delivery' },
  paid_in: { label: 'Paid in', sign: 1, hint: 'Cash put into the drawer, e.g. change from the bank' },
} as const;
export type CashMovementKind = keyof typeof CASH_MOVEMENT_KINDS;

export interface DrawerMovement {
  movement_id: string;
  kind: CashMovementKind;
  amount_cents: Cents;
  reason: string;
  at: string;
  by_user_id: string | null;
}

export interface DrawerSession {
  session_id: string;
  register_id: string;
  opened_at: string;
  opened_by: string | null;
  float_cents: Cents;
  cash_sales_cents: Cents;
  cash_sale_count: number;
  cash_refunds_cents: Cents;
  paid_in_cents: Cents;
  paid_out_cents: Cents;
  drops_cents: Cents;
  /** Drawer opens that weren't a cash sale ("no sale"), for the shrink view. */
  no_sale_opens: number;
  movements: DrawerMovement[];
  /** What the drawer should hold right now (open) or held at close. */
  expected_cents: Cents;
  closed_at: string | null;
  closed_by: string | null;
  counted_cents: Cents | null;
  /** counted − expected: positive over, negative short. Null while open. */
  over_short_cents: Cents | null;
}

function expectedOf(s: Omit<DrawerSession, 'expected_cents'>): Cents {
  return sub(add(s.float_cents, s.cash_sales_cents, s.paid_in_cents), add(s.cash_refunds_cents, s.paid_out_cents, s.drops_cents));
}

/**
 * Fold one register's events (any order; sorted by device_seq here) into its drawer sessions,
 * oldest first. Cash taken before any session was opened is not lost: it is reported in
 * `unassigned_cash_cents`, so a register used without opening a drawer still reconciles.
 */
export function foldDrawer(events: readonly RegisterEvent[]): { sessions: DrawerSession[]; unassigned_cash_cents: Cents } {
  const ordered = [...events].sort((a, b) => a.device_seq - b.device_seq);
  const sessions: DrawerSession[] = [];
  let cur: Omit<DrawerSession, 'expected_cents'> | null = null;
  let unassigned: Cents = ZERO;
  const finish = (s: Omit<DrawerSession, 'expected_cents'>): DrawerSession => ({ ...s, expected_cents: expectedOf(s) });

  for (const e of ordered) {
    switch (e.type) {
      case 'drawer.session_opened':
        if (cur) sessions.push(finish(cur)); // a session never closed (crash, forgotten) ends where the next begins
        cur = {
          session_id: e.payload.session_id,
          register_id: e.register_id,
          opened_at: e.occurred_at,
          opened_by: e.actor_user_id,
          float_cents: cents(e.payload.float_cents),
          cash_sales_cents: ZERO,
          cash_sale_count: 0,
          cash_refunds_cents: ZERO,
          paid_in_cents: ZERO,
          paid_out_cents: ZERO,
          drops_cents: ZERO,
          no_sale_opens: 0,
          movements: [],
          closed_at: null,
          closed_by: null,
          counted_cents: null,
          over_short_cents: null,
        };
        break;
      case 'sale.tender_added':
        if (e.payload.tender_type !== 'cash') break;
        if (cur) {
          cur.cash_sales_cents = add(cur.cash_sales_cents, cents(e.payload.amount_cents));
          cur.cash_sale_count++;
        } else unassigned = add(unassigned, cents(e.payload.amount_cents));
        break;
      case 'sale.refunded':
        if (e.payload.tender_type !== 'cash') break;
        if (cur) cur.cash_refunds_cents = add(cur.cash_refunds_cents, cents(e.payload.amount_cents));
        else unassigned = sub(unassigned, cents(e.payload.amount_cents));
        break;
      case 'drawer.cash_movement': {
        if (!cur) break;
        const amount = cents(e.payload.amount_cents);
        if (e.payload.kind === 'drop') cur.drops_cents = add(cur.drops_cents, amount);
        else if (e.payload.kind === 'paid_out') cur.paid_out_cents = add(cur.paid_out_cents, amount);
        else cur.paid_in_cents = add(cur.paid_in_cents, amount);
        cur.movements.push({ movement_id: e.payload.movement_id, kind: e.payload.kind, amount_cents: amount, reason: e.payload.reason, at: e.occurred_at, by_user_id: e.actor_user_id });
        break;
      }
      case 'drawer.opened':
        if (cur && e.payload.reason === 'manual') cur.no_sale_opens++;
        break;
      case 'drawer.session_closed':
        if (!cur || cur.session_id !== e.payload.session_id) break;
        cur.closed_at = e.occurred_at;
        cur.closed_by = e.actor_user_id;
        cur.counted_cents = cents(e.payload.counted_cents);
        cur.over_short_cents = sub(cents(e.payload.counted_cents), expectedOf(cur));
        sessions.push(finish(cur));
        cur = null;
        break;
      default:
        break;
    }
  }
  if (cur) sessions.push(finish(cur));
  return { sessions, unassigned_cash_cents: unassigned };
}

/** Over/short per person who closed sessions, for "over/short by cashier; trend over time". */
export function overShortByCashier(sessions: readonly DrawerSession[]): { user_id: string | null; sessions: number; over_short_cents: Cents }[] {
  const by = new Map<string | null, DrawerSession[]>();
  for (const s of sessions) if (s.over_short_cents !== null) by.set(s.closed_by, [...(by.get(s.closed_by) ?? []), s]);
  return [...by.entries()].map(([user_id, ss]) => ({ user_id, sessions: ss.length, over_short_cents: sum(ss.map((s) => s.over_short_cents!)) }));
}

/** One drawer session as the reports show it (merchant app Cash tab, admin). */
export interface CashSessionRow extends DrawerSession {
  register_name: string;
  location_name: string;
  opened_by_name: string | null;
  closed_by_name: string | null;
  business_date: string;
}

export interface CashReport {
  range: 'today' | 'week' | 'month';
  from: string;
  to: string;
  sessions: CashSessionRow[];
  /** Closed sessions only: over/short by the person who counted. */
  by_cashier: { user_id: string | null; name: string | null; sessions: number; over_short_cents: number }[];
  /** Over/short per business day (closed sessions), oldest first: the trend. */
  by_day: { date: string; sessions: number; over_short_cents: number }[];
  totals: { drops_cents: number; paid_out_cents: number; paid_in_cents: number; over_short_cents: number; no_sale_opens: number };
}
