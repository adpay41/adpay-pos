/**
 * Loyalty by phone number (Bible 1.5, 2.7; build plan P19a, ADR 0029). No app, no card: the customer
 * types their number on the customer screen.
 *
 * - The phone number never enters the event log or the register's storage. A sale carries
 *   `customer_ref` = HMAC-SHA256(merchant salt, +1XXXXXXXXXX) and the last four digits. The number
 *   itself reaches the server only when the customer opts in to texts, and is checked against the ref.
 * - Balances are folded from the sales on read (never stored): visits or points earned by completed
 *   sales, minus what rewards used. The register asks the server; earning works offline, a reward
 *   needs a connection (the balance must be verified).
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import type { FoldedLine, FoldedSale } from './fold';

export const LoyaltyReward = z.discriminatedUnion('kind', [
  /** The cheapest qualifying item free, up to a cap ("5th coffee free"). */
  z.strictObject({ kind: z.literal('free_item'), max_cents: z.int().min(1).max(10_000) }),
  z.strictObject({ kind: z.literal('amount_off'), cents: z.int().min(1).max(10_000) }),
]);
export type LoyaltyReward = z.infer<typeof LoyaltyReward>;

export const LoyaltySettingsInput = z.strictObject({
  enabled: z.boolean().default(false),
  /** visits = a punch card; points = per dollar spent. */
  kind: z.enum(['visits', 'points']).default('visits'),
  visits_needed: z.int().min(2).max(20).default(5),
  points_per_dollar: z.int().min(1).max(20).default(1),
  points_needed: z.int().min(10).max(10_000).default(100),
  /** Only tickets with an item from this category count, and a free item comes from it. Null = any. */
  qualifying_category_id: z.uuid().nullable().default(null),
  /** A ticket must be at least this (cash-price subtotal) to count. */
  min_ticket_cents: z.int().min(0).max(100_000).default(0),
  reward: LoyaltyReward.default({ kind: 'free_item', max_cents: 500 }),
  /** Ask on the customer screen whether they want the store's texts (promos). */
  ask_for_texts: z.boolean().default(true),
});
export type LoyaltySettings = z.infer<typeof LoyaltySettingsInput>;
export const DEFAULT_LOYALTY: LoyaltySettings = LoyaltySettingsInput.parse({});

/** The consent sentence shown next to the checkbox. Its version is stored with every opt-in. */
export const TEXT_CONSENT_VERSION = 'v1';
export const textConsent = (store: string) =>
  `Yes, text me deals from ${store}. Up to 4 texts a month. Msg & data rates may apply. Reply STOP to stop, HELP for help. Consent isn't required to buy.`;

/** US mobile → +1XXXXXXXXXX, or null. */
export function normalizeUsPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

/** The pseudonymous customer id a sale carries (hex). */
export function customerRef(salt: string, e164: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(salt), utf8ToBytes(e164)));
}

export const CustomerRefSchema = z.string().regex(/^[0-9a-f]{64}$/);

const qualifyingLines = (s: LoyaltySettings, sale: FoldedSale): FoldedLine[] =>
  sale.lines.filter((l) => !l.is_fee && (s.qualifying_category_id === null || l.category_id === s.qualifying_category_id));

/** What one completed sale earns. A voided sale earns nothing. */
export function earned(s: LoyaltySettings, sale: FoldedSale): { visits: number; points: number } {
  if (sale.status !== 'completed') return { visits: 0, points: 0 };
  const subtotal = (sale.declared ?? sale.cash).subtotal_cents;
  if (subtotal < s.min_ticket_cents || qualifyingLines(s, sale).length === 0) return { visits: 0, points: 0 };
  return s.kind === 'visits' ? { visits: 1, points: 0 } : { visits: 0, points: Math.floor(subtotal / 100) * s.points_per_dollar };
}

export interface LoyaltyStatus {
  kind: LoyaltySettings['kind'];
  /** Visits or points toward the next reward, after rewards already used. */
  balance: number;
  needed: number;
  rewards_available: number;
  /** Visits or points still to go for the next reward. */
  to_next: number;
  visits: number;
  spent_cents: number;
  last_visit: string | null;
}

/** Fold a customer's sales into their standing. */
export function loyaltyStatus(s: LoyaltySettings, sales: readonly (FoldedSale & { occurred_at?: string })[]): LoyaltyStatus {
  let earnedTotal = 0;
  let used = 0;
  let visits = 0;
  let spent = 0;
  let last: string | null = null;
  for (const sale of sales) {
    const e = earned(s, sale);
    earnedTotal += s.kind === 'visits' ? e.visits : e.points;
    used += sale.loyalty?.cost ?? 0;
    if (sale.status === 'completed') {
      visits++;
      spent += (sale.declared ?? sale.cash).total_cents;
      if (sale.occurred_at && (!last || sale.occurred_at > last)) last = sale.occurred_at;
    }
  }
  const needed = s.kind === 'visits' ? s.visits_needed : s.points_needed;
  const balance = Math.max(0, earnedTotal - used);
  return {
    kind: s.kind,
    balance,
    needed,
    rewards_available: Math.floor(balance / needed),
    to_next: needed - (balance % needed),
    visits,
    spent_cents: spent,
    last_visit: last,
  };
}

/**
 * The line discounts a reward applies to an open sale, and what it costs from the balance. A line
 * already discounted is left alone. Null when nothing on the ticket can take the reward.
 */
export function rewardDiscounts(
  s: LoyaltySettings,
  sale: FoldedSale,
): { lines: { line_id: string; cash_discount_cents: number; card_discount_cents: number }[]; discount_cents: number; cost: number } | null {
  const cost = s.kind === 'visits' ? s.visits_needed : s.points_needed;
  const open = sale.lines.filter((l) => !l.is_fee && l.cash_discount_cents === 0 && l.card_discount_cents === 0);
  if (s.reward.kind === 'free_item') {
    const pool = open.filter((l) => s.qualifying_category_id === null || l.category_id === s.qualifying_category_id);
    const line = [...pool].sort((a, b) => a.unit_cash_price_cents - b.unit_cash_price_cents)[0];
    if (!line) return null;
    const cash = Math.min(line.unit_cash_price_cents, s.reward.max_cents);
    const card = Math.min(line.unit_card_price_cents, s.reward.max_cents);
    return { lines: [{ line_id: line.line_id, cash_discount_cents: cash, card_discount_cents: card }], discount_cents: cash, cost };
  }
  // A fixed amount off: from the most expensive line down, never below zero on a line.
  let left = s.reward.cents;
  const lines: { line_id: string; cash_discount_cents: number; card_discount_cents: number }[] = [];
  for (const l of [...open].sort((a, b) => b.unit_cash_price_cents * b.qty - a.unit_cash_price_cents * a.qty)) {
    if (left <= 0) break;
    const take = Math.min(left, l.unit_cash_price_cents * l.qty, l.unit_card_price_cents * l.qty);
    if (take <= 0) continue;
    lines.push({ line_id: l.line_id, cash_discount_cents: take, card_discount_cents: take });
    left -= take;
  }
  if (lines.length === 0) return null;
  return { lines, discount_cents: s.reward.cents - left, cost };
}
