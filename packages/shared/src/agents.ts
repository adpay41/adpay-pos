/**
 * Referral partners and sales agents, and their residual split (Bible 3.1; P25b, ADR 0040).
 *
 * An agent brings stores. Their terms (share of AD Pay's margin or revenue from each store, and a
 * one-time bounty when a store goes live) are dated and append-only, like pricing plans: a change
 * never rewrites a month already paid. A store's agent is also dated. Payouts are computed from
 * the residual report (ADR 0022), never typed; paying the agent is outside the system.
 */
import { z } from 'zod';
import type { ResidualRow } from './analyzer';

export const AGENT_KINDS = { agent: 'Sales agent', referral: 'Referral partner', iso: 'ISO / reseller' } as const;
export type AgentKind = keyof typeof AGENT_KINDS;
export const AGENT_KIND_KEYS = Object.keys(AGENT_KINDS) as AgentKind[];

export const AgentInput = z.strictObject({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(AGENT_KIND_KEYS as [AgentKind, ...AgentKind[]]),
  email: z.email().max(120).nullable().default(null),
  phone: z.string().trim().max(30).nullable().default(null),
  /** Given to stores at signup ("who sent you?"); letters and digits. */
  referral_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4,12}$/, '4–12 letters or digits'),
});
export type AgentInput = z.infer<typeof AgentInput>;

/** Share of AD Pay's margin (revenue − processor cost) or of its revenue. */
export const SPLIT_BASES = { margin: 'Share of margin', revenue: 'Share of revenue' } as const;
export type SplitBasis = keyof typeof SPLIT_BASES;

export const AgentTermsInput = z.strictObject({
  effective_from: z.string().regex(/^\d{4}-\d{2}-01$/, 'Terms start on the first of a month'),
  basis: z.enum(['margin', 'revenue']),
  /** Parts per million of the basis; at most 80%. */
  split_ppm: z.int().min(0).max(800_000),
  /** Paid once, in the month the store's first sale is made. */
  bounty_cents: z.int().min(0).max(1_000_000),
});
export type AgentTerms = z.infer<typeof AgentTermsInput>;

export const MerchantAgentInput = z.strictObject({
  /** Null takes the store off any agent from that date. */
  agent_id: z.uuid().nullable(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-01$/, 'Starts on the first of a month'),
  note: z.string().trim().max(200).nullable().default(null),
});

/** The dated row in force on `date` (YYYY-MM-DD): latest effective_from ≤ date, then latest written. */
export function inForce<T extends { effective_from: string; created_at: string }>(rows: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.effective_from > date) continue;
    if (!best || r.effective_from > best.effective_from || (r.effective_from === best.effective_from && r.created_at > best.created_at)) best = r;
  }
  return best;
}

export interface AgentLine {
  merchant_id: string;
  merchant_name: string;
  card_volume_cents: number;
  revenue_cents: number;
  margin_cents: number | null;
  basis: SplitBasis;
  split_ppm: number;
  /** Null when the basis is margin and the processor cost for the month isn't in yet. */
  residual_cents: number | null;
  bounty_cents: number;
}

/**
 * One store's line on an agent's statement. Integer cents, rounded down. A negative basis pays
 * nothing that month (no clawback in v1); a margin split waits for the month's processor cost.
 */
export function agentLine(r: ResidualRow, terms: AgentTerms, firstSaleThisMonth: boolean): AgentLine {
  const basis = terms.basis === 'margin' ? r.margin_cents : r.revenue_cents;
  const residual = basis === null ? null : Math.max(0, Math.floor((basis * terms.split_ppm) / 1_000_000));
  return {
    merchant_id: r.merchant_id,
    merchant_name: r.merchant_name,
    card_volume_cents: r.card_volume_cents,
    revenue_cents: r.revenue_cents,
    margin_cents: r.margin_cents,
    basis: terms.basis,
    split_ppm: terms.split_ppm,
    residual_cents: residual,
    bounty_cents: firstSaleThisMonth ? terms.bounty_cents : 0,
  };
}

export interface AgentStatement {
  agent_id: string;
  agent_name: string;
  kind: AgentKind;
  month: string;
  lines: AgentLine[];
  residual_cents: number;
  bounty_cents: number;
  total_cents: number;
  /** Stores whose margin split can't be computed yet (processor cost not entered). */
  pending: number;
}

/** Payout CSV for a month: one row per agent per store, then a total per agent. */
export function agentStatementsCsv(statements: readonly AgentStatement[]): string {
  const money = (c: number | null) => (c === null ? '' : `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`);
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out = ['month,agent,store,basis,split_percent,card_volume,revenue,margin,residual,bounty'];
  for (const s of statements) {
    for (const l of s.lines) {
      out.push(
        [s.month, q(s.agent_name), q(l.merchant_name), l.basis, `${Math.floor(l.split_ppm / 10_000)}.${String(l.split_ppm % 10_000).padStart(4, '0')}`, money(l.card_volume_cents), money(l.revenue_cents), money(l.margin_cents), money(l.residual_cents), money(l.bounty_cents)].join(','),
      );
    }
    out.push([s.month, q(s.agent_name), 'TOTAL', '', '', '', '', '', money(s.residual_cents), money(s.bounty_cents)].join(','));
  }
  return `${out.join('\n')}\n`;
}
