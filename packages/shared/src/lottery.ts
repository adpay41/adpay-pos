/**
 * Lottery module (build plan P17, Bible 1.4): scratch-off packs received and activated into bins,
 * tickets sold counted from the bins' ticket numbers, and a daily reconciliation against the state
 * terminal's report (typed in: there is no state lottery API) and the drawer's lottery payouts.
 * ADR 0027. Integer cents; ticket numbers are integers.
 *
 * Tickets in a pack are numbered 0 … size−1 and sold in ascending order, so the tickets sold from
 * a bin since the last count are `now − before` (the next ticket to sell). A pack sold out counts
 * as `size`.
 */
import { z } from 'zod';

export const LotteryGameInput = z.strictObject({
  game_number: z.string().trim().regex(/^[0-9]{3,5}$/, 'Game number: 3–5 digits'),
  name: z.string().trim().min(1).max(60),
  price_cents: z.int().min(100).max(10_000),
  tickets_per_pack: z.int().min(10).max(1_000),
});
export type LotteryGame = z.infer<typeof LotteryGameInput> & { game_id: string; active: boolean };

export const PACK_STATUSES = ['received', 'active', 'sold_out', 'returned'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

export interface LotteryPack {
  pack_id: string;
  game_id: string;
  game_number: string;
  game_name: string;
  price_cents: number;
  tickets_per_pack: number;
  pack_number: string;
  status: PackStatus;
  bin: number | null;
  /** First ticket not yet sold when activated (usually 0). */
  start_ticket: number;
  received_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

export const PackReceiveInput = z.strictObject({
  game_id: z.uuid(),
  pack_number: z.string().trim().regex(/^[0-9]{4,10}$/, 'Pack number: 4–10 digits'),
});
export const PackActivateInput = z.strictObject({ bin: z.int().min(1).max(99), start_ticket: z.int().min(0).max(999).default(0) });

/**
 * A daily count: for each active pack, the next ticket to sell (the number on the ticket showing).
 * `sold_out: true` when the bin emptied.
 */
export const LotteryCountInput = z.strictObject({
  business_date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  entries: z
    .array(z.strictObject({ pack_id: z.uuid(), next_ticket: z.int().min(0).max(1_000), sold_out: z.boolean().default(false) }))
    .min(1)
    .max(200),
});

/** The state terminal's daily report, typed in (no state lottery API integration). */
export const TerminalReportInput = z.strictObject({
  business_date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  /** Draw-game sales (Pick-3, Powerball…) the terminal sold. */
  online_sales_cents: z.int().min(0).max(100_000_000),
  /** Winning tickets cashed (instant and draw) per the terminal. */
  cashes_cents: z.int().min(0).max(100_000_000),
  /** Instant (scratch-off) sales the terminal settled, if the report shows them. */
  instant_sales_cents: z.int().min(0).max(100_000_000).nullable().default(null),
});

/** Tickets sold from one pack between two readings. */
export function ticketsSold(before: number, now: { next_ticket: number; sold_out: boolean }, size: number): number {
  const end = now.sold_out ? size : Math.min(now.next_ticket, size);
  return Math.max(0, end - before);
}

export interface LotteryDay {
  business_date: string;
  /** Scratch-offs sold per the bin counts, by game. */
  instant: { game_number: string; game_name: string; tickets: number; amount_cents: number }[];
  instant_cents: number;
  /** Lottery rung at the register (lottery-restricted lines on completed sales). */
  rung_cents: number;
  /** Lottery payouts from the drawer (paid-outs with a lottery reason). */
  drawer_payouts_cents: number;
  terminal: { online_sales_cents: number; cashes_cents: number; instant_sales_cents: number | null } | null;
  counted: boolean;
  /** rung − (instant counted + terminal online sales): money rung that the counts don't explain (+) or sales not rung (−). */
  sales_difference_cents: number | null;
  /** drawer payouts − terminal cashes: cash paid out that the terminal didn't cash (+). */
  payout_difference_cents: number | null;
}

export function reconcileDay(d: Omit<LotteryDay, 'sales_difference_cents' | 'payout_difference_cents' | 'instant_cents'>): LotteryDay {
  const instant_cents = d.instant.reduce((n, g) => n + g.amount_cents, 0);
  return {
    ...d,
    instant_cents,
    sales_difference_cents: d.terminal && d.counted ? d.rung_cents - (instant_cents + d.terminal.online_sales_cents) : null,
    payout_difference_cents: d.terminal ? d.drawer_payouts_cents - d.terminal.cashes_cents : null,
  };
}

/** Daily lottery reconciliation as CSV, one row per day (the lottery part of the compliance export). */
export function lotteryCsv(days: readonly LotteryDay[]): string {
  const m = (c: number | null) => (c === null ? '' : `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`);
  const head = 'Date,Scratch-offs sold (count),Tickets,Lottery rung,Drawer payouts,Terminal online sales,Terminal cashed,Rung vs counted+online,Paid out vs cashed';
  return [head, ...days.map((d) => [d.business_date, d.counted ? m(d.instant_cents) : '', d.instant.reduce((n, g) => n + g.tickets, 0), m(d.rung_cents), m(d.drawer_payouts_cents), m(d.terminal?.online_sales_cents ?? null), m(d.terminal?.cashes_cents ?? null), m(d.sales_difference_cents), m(d.payout_difference_cents)].join(','))].join('\n') + '\n';
}
