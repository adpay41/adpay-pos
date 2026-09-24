/**
 * Money math for AD Pay's side of the business (build plan P13, Bible 3.1 L41, 3.3 L50, 3.5 L53).
 * ADR 0022. Integer cents and ppm throughout; each division rounds half-up once.
 *
 *  - Statement analyzer: what a prospect pays today (from their statement, entered by hand until
 *    the PDF parsers exist, ⛔ samples) against what they would pay on each AD Pay plan.
 *  - Residuals: what AD Pay earns from a merchant in a month under the plan in force, and the
 *    margin after processor cost (entered by hand until the Finix rate card and data exist, ⛔).
 */
import { z } from 'zod';
import { ppmToPercent } from './catalog';
import { PricingPlanInput, type PricingPlan } from './onboarding';

/** round(n / d) half-up for non-negative n, d > 0. */
function div(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

/** amount × ppm, rounded half-up once. */
export function ppmOf(amountCents: number, ppm: number): number {
  return div(amountCents * ppm, 1_000_000);
}

/** part / whole as ppm (1% = 10_000); null when whole is 0. */
export function ratePpm(part: number, whole: number): number | null {
  return whole > 0 ? div(part * 1_000_000, whole) : null;
}

// ───────────────────────────────────────────────────────────────────────── analyzer ──

export const StatementInput = z.strictObject({
  prospect: z.string().trim().min(1).max(120),
  processor: z.string().trim().max(60).default(''),
  /** The statement's month, YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month as YYYY-MM'),
  card_volume_cents: z.int().min(1).max(10_000_000_00),
  transactions: z.int().min(1).max(1_000_000),
  total_fees_cents: z.int().min(0).max(1_000_000_00),
  /** Interchange + assessments from the statement, when it shows them; else leave null. */
  interchange_cents: z.int().min(0).max(1_000_000_00).nullable().default(null),
  /** Monthly POS/software they pay on top (Clover etc.), cents. */
  pos_fees_cents: z.int().min(0).max(10_000_00).default(0),
  registers: z.int().min(1).max(20).default(1),
  /** What AD Pay offers this prospect (1–3 plans); the one-pager compares today with each. */
  offers: z.array(PricingPlanInput).min(1).max(3),
});
export type StatementEntry = z.infer<typeof StatementInput>;

export interface PlanQuote {
  plan: PricingPlan;
  /** What the merchant pays AD Pay in the month (processing + subscription), cents. */
  merchant_cost_cents: number;
  /** Saving against today's total (fees + POS), cents per month; negative = costs more. */
  saving_cents: number;
  /** Null when the comparison needs interchange and the statement didn't show it. */
  note: string | null;
}

export interface StatementAnalysis {
  effective_rate_ppm: number;
  /** Fees above interchange (the processor's markup), when interchange is known. */
  markup_cents: number | null;
  markup_rate_ppm: number | null;
  today_total_cents: number;
  average_ticket_cents: number;
  quotes: PlanQuote[];
}

const subscription = (p: PricingPlan, registers: number) => p.monthly_cents + p.per_register_cents * Math.max(0, registers - 1);

/**
 * Compare a statement with plans. Dual pricing: card customers pay the posted card price, so the
 * merchant's processing cost is zero and only the subscription remains. IC+ needs interchange
 * (passed through at cost). Flat is rate × volume + per-transaction fees.
 */
export function analyzeStatement(s: StatementEntry, plans: readonly PricingPlan[]): StatementAnalysis {
  const todayTotal = s.total_fees_cents + s.pos_fees_cents;
  const markup = s.interchange_cents === null ? null : Math.max(0, s.total_fees_cents - s.interchange_cents);
  const quotes = plans.map((plan): PlanQuote => {
    const sub = subscription(plan, s.registers);
    let processing: number | null;
    let note: string | null = null;
    if (plan.kind === 'dual_pricing') {
      processing = 0;
      note = `Card customers pay the posted card price (+${ppmToPercent(plan.dual_price_rate_ppm)}%); cash customers pay the cash price.`;
    } else if (plan.kind === 'ic_plus') {
      processing = s.interchange_cents === null ? null : s.interchange_cents + ppmOf(s.card_volume_cents, plan.markup_ppm) + plan.per_txn_cents * s.transactions;
      if (processing === null) note = 'Needs interchange from the statement to compare.';
    } else {
      processing = ppmOf(s.card_volume_cents, plan.rate_ppm) + plan.per_txn_cents * s.transactions;
    }
    const cost = processing === null ? sub : processing + sub;
    return { plan, merchant_cost_cents: cost, saving_cents: processing === null ? 0 : todayTotal - cost, note };
  });
  return {
    effective_rate_ppm: ratePpm(s.total_fees_cents, s.card_volume_cents)!,
    markup_cents: markup,
    markup_rate_ppm: markup === null ? null : ratePpm(markup, s.card_volume_cents),
    today_total_cents: todayTotal,
    average_ticket_cents: div(s.card_volume_cents, s.transactions),
    quotes,
  };
}

// ───────────────────────────────────────────────────────────────────────── residuals ──

/** Processor cost for a merchant-month, entered by hand until Finix data arrives (⛔). */
export const ProcessorCostInput = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  interchange_cents: z.int().min(0).max(1_000_000_00),
  processor_fees_cents: z.int().min(0).max(1_000_000_00),
  note: z.string().trim().max(200).nullable().default(null),
});
export type ProcessorCost = z.infer<typeof ProcessorCostInput>;

export interface ResidualInputs {
  card_volume_cents: number;
  card_transactions: number;
  registers: number;
  plan: PricingPlan | null;
  cost: { interchange_cents: number; processor_fees_cents: number } | null;
}

export interface Residual {
  processing_revenue_cents: number;
  subscription_revenue_cents: number;
  revenue_cents: number;
  /** What AD Pay pays out of the revenue: interchange (unless passed through) + processor fees. */
  cost_cents: number | null;
  margin_cents: number | null;
  /** Our revenue over card volume, ppm. */
  effective_rate_ppm: number | null;
}

/**
 * AD Pay's revenue and margin for a merchant-month.
 *  - Dual pricing: the card surcharge collected is the processing revenue. With a card price of
 *    cash × (1 + r), the surcharge inside a card volume V is V × r / (1 + r). Cost is interchange +
 *    processor fees.
 *  - IC+: interchange passes through (neither revenue nor cost); revenue is markup × V + per-txn;
 *    cost is the processor's fees.
 *  - Flat: revenue is rate × V + per-txn; cost is interchange + processor fees.
 */
export function residual(i: ResidualInputs): Residual {
  const plan = i.plan;
  let processing = 0;
  if (plan?.kind === 'dual_pricing') processing = div(i.card_volume_cents * plan.dual_price_rate_ppm, 1_000_000 + plan.dual_price_rate_ppm);
  else if (plan?.kind === 'ic_plus') processing = ppmOf(i.card_volume_cents, plan.markup_ppm) + plan.per_txn_cents * i.card_transactions;
  else if (plan?.kind === 'flat') processing = ppmOf(i.card_volume_cents, plan.rate_ppm) + plan.per_txn_cents * i.card_transactions;
  const sub = plan ? subscription(plan, i.registers) : 0;
  const revenue = processing + sub;
  const cost = i.cost === null ? null : (plan?.kind === 'ic_plus' ? 0 : i.cost.interchange_cents) + i.cost.processor_fees_cents;
  return {
    processing_revenue_cents: processing,
    subscription_revenue_cents: sub,
    revenue_cents: revenue,
    cost_cents: cost,
    margin_cents: cost === null ? null : revenue - cost,
    effective_rate_ppm: ratePpm(processing, i.card_volume_cents),
  };
}

export interface ResidualRow extends Residual {
  merchant_id: string;
  merchant_name: string;
  month: string;
  plan_kind: PricingPlan['kind'] | null;
  card_volume_cents: number;
  card_transactions: number;
  cash_volume_cents: number;
  registers: number;
  cost_entered: boolean;
}

export interface Kpis {
  as_of: string;
  stores_live: number;
  stores_active_7d: number;
  /** Live stores with no sale in 14 days: the churn warning list. */
  stores_quiet_14d: { merchant_id: string; merchant_name: string; last_sale_at: string | null }[];
  registers_paired: number;
  month: string;
  volume_cents: number;
  card_volume_cents: number;
  revenue_cents: number;
  margin_cents: number | null;
  effective_rate_ppm: number | null;
  support_messages_7d: number;
  support_unread: number;
  installs_by_week: { week: string; registers: number }[];
}
