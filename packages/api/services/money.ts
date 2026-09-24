/**
 * AD Pay's own numbers (build plan P13, ADR 0022): statement analyses for prospects, the residual /
 * margin report per merchant per month, and the KPI dashboard. Volumes come from the immutable sale
 * event log; revenue from the pricing plan in force; processor cost is typed in until Finix data
 * exists (⛔). All money integer cents.
 */
import {
  PricingPlanInput,
  StatementInput,
  analyzeStatement,
  localDate,
  planOn,
  ratePpm,
  residual,
  type Kpis,
  type PricingPlan,
  type ProcessorCost,
  type ResidualRow,
  type StatementAnalysis,
  type StatementEntry,
} from '@adpay/shared';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { notFound } from '../http/errors';
import { audit } from './audit';

// ───────────────────────────────────────────────────────────────────────── analyzer ──

export interface SavedAnalysis {
  analysis_id: string;
  entry: StatementEntry;
  analysis: StatementAnalysis;
  created_at: string;
  created_by_name: string | null;
}

export async function saveAnalysis(db: Db, actor: AdminPrincipal, entry: StatementEntry, traceId: string): Promise<{ analysis_id: string }> {
  const { rows } = await db.query<{ analysis_id: string }>('INSERT INTO statement_analyses (entry, created_by, trace_id) VALUES ($1, $2, $3) RETURNING analysis_id', [
    JSON.stringify(entry),
    actor.user_id,
    traceId,
  ]);
  await audit(db, { actor, action: 'analyzer.saved', target: rows[0]!.analysis_id, details: { prospect: entry.prospect, month: entry.month }, trace_id: traceId });
  return rows[0]!;
}

export async function listAnalyses(q: Queryable, id: string | null = null): Promise<SavedAnalysis[]> {
  const { rows } = await q.query<{ analysis_id: string; entry: unknown; created_at: Date; created_by_name: string | null }>(
    `SELECT a.analysis_id, a.entry, a.created_at, coalesce(u.name, u.email) AS created_by_name
       FROM statement_analyses a LEFT JOIN users u ON u.user_id = a.created_by
      WHERE ($1::uuid IS NULL OR a.analysis_id = $1) ORDER BY a.created_at DESC LIMIT 200`,
    [id],
  );
  return rows.flatMap((r) => {
    const entry = StatementInput.safeParse(r.entry);
    if (!entry.success) return [];
    return [{ analysis_id: r.analysis_id, entry: entry.data, analysis: analyzeStatement(entry.data, entry.data.offers), created_at: new Date(r.created_at).toISOString(), created_by_name: r.created_by_name }];
  });
}

// ───────────────────────────────────────────────────────────────────────── residuals ──

export async function setProcessorCost(db: Db, actor: AdminPrincipal, merchantId: string, cost: ProcessorCost, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
    if (!rows[0]) throw notFound('Merchant not found');
    const { rows: before } = await q.query('SELECT interchange_cents, processor_fees_cents, note FROM processor_costs WHERE merchant_id = $1 AND month = $2', [merchantId, cost.month]);
    await q.query(
      `INSERT INTO processor_costs (org_id, merchant_id, month, interchange_cents, processor_fees_cents, note, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (merchant_id, month) DO UPDATE SET interchange_cents = EXCLUDED.interchange_cents, processor_fees_cents = EXCLUDED.processor_fees_cents,
         note = EXCLUDED.note, entered_by = EXCLUDED.entered_by, entered_at = now()`,
      [rows[0].org_id, merchantId, cost.month, cost.interchange_cents, cost.processor_fees_cents, cost.note, actor.user_id],
    );
    await audit(q, { actor, action: 'money.processor_cost_set', tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: merchantId, details: { from: before[0] ?? null, to: cost }, trace_id: traceId });
  });
}

/** Last day of a YYYY-MM month, as YYYY-MM-DD (the plan in force at month end prices the month). */
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

export async function residualReport(q: Queryable, month: string, merchantId: string | null = null): Promise<ResidualRow[]> {
  const { rows } = await q.query<{
    merchant_id: string;
    merchant_name: string;
    registers: number;
    card_cents: string | number;
    card_txns: number;
    card_refunds_cents: string | number;
    cash_cents: string | number;
    interchange_cents: string | number | null;
    processor_fees_cents: string | number | null;
  }>(
    `WITH ev AS (
       SELECT merchant_id,
              coalesce(sum((payload->>'amount_cents')::bigint) FILTER (WHERE type = 'sale.tender_added' AND payload->>'tender_type' = 'card' AND payload->'card'->>'status' = 'approved'), 0) AS card_cents,
              count(*) FILTER (WHERE type = 'sale.tender_added' AND payload->>'tender_type' = 'card' AND payload->'card'->>'status' = 'approved')::int AS card_txns,
              coalesce(sum((payload->>'amount_cents')::bigint) FILTER (WHERE type = 'sale.refunded' AND payload->>'tender_type' = 'card'), 0) AS card_refunds_cents,
              coalesce(sum((payload->>'amount_cents')::bigint) FILTER (WHERE type = 'sale.tender_added' AND payload->>'tender_type' = 'cash'), 0)
                - coalesce(sum((payload->>'amount_cents')::bigint) FILTER (WHERE type = 'sale.refunded' AND payload->>'tender_type' = 'cash'), 0) AS cash_cents
         FROM sale_events
        WHERE business_date BETWEEN ($1 || '-01')::date AND $2::date AND ($3::uuid IS NULL OR merchant_id = $3::uuid)
        GROUP BY merchant_id)
     SELECT m.merchant_id, m.name AS merchant_name,
            (SELECT count(*)::int FROM registers r WHERE r.merchant_id = m.merchant_id AND r.status <> 'retired') AS registers,
            coalesce(ev.card_cents, 0) AS card_cents, coalesce(ev.card_txns, 0) AS card_txns,
            coalesce(ev.card_refunds_cents, 0) AS card_refunds_cents, coalesce(ev.cash_cents, 0) AS cash_cents,
            pc.interchange_cents, pc.processor_fees_cents
       FROM merchants m
       LEFT JOIN ev ON ev.merchant_id = m.merchant_id
       LEFT JOIN processor_costs pc ON pc.merchant_id = m.merchant_id AND pc.month = $1
      WHERE ($3::uuid IS NULL OR m.merchant_id = $3::uuid)
      ORDER BY m.name`,
    [month, monthEnd(month), merchantId],
  );
  const { rows: planRows } = await q.query<{ merchant_id: string; plan: unknown; created_at: Date }>(
    'SELECT merchant_id, plan, created_at FROM merchant_pricing_plans WHERE ($1::uuid IS NULL OR merchant_id = $1::uuid)',
    [merchantId],
  );
  const plansBy = new Map<string, { plan: PricingPlan; created_at: string }[]>();
  for (const p of planRows) {
    const plan = PricingPlanInput.safeParse(p.plan);
    if (plan.success) plansBy.set(p.merchant_id, [...(plansBy.get(p.merchant_id) ?? []), { plan: plan.data, created_at: new Date(p.created_at).toISOString() }]);
  }
  return rows.map((r) => {
    const plan = planOn(plansBy.get(r.merchant_id) ?? [], monthEnd(month))?.plan ?? null;
    const card = Number(r.card_cents) - Number(r.card_refunds_cents);
    const cost = r.interchange_cents === null ? null : { interchange_cents: Number(r.interchange_cents), processor_fees_cents: Number(r.processor_fees_cents) };
    return {
      merchant_id: r.merchant_id,
      merchant_name: r.merchant_name,
      month,
      plan_kind: plan?.kind ?? null,
      card_volume_cents: card,
      card_transactions: r.card_txns,
      cash_volume_cents: Number(r.cash_cents),
      registers: r.registers,
      cost_entered: cost !== null,
      ...residual({ card_volume_cents: Math.max(0, card), card_transactions: r.card_txns, registers: r.registers, plan, cost }),
    };
  });
}

// ───────────────────────────────────────────────────────────────────────── KPIs ──

export async function kpis(q: Queryable, now = new Date()): Promise<Kpis> {
  const today = localDate(now, 'America/New_York');
  const month = today.slice(0, 7);
  const report = await residualReport(q, month);
  const { rows: live } = await q.query<{ merchant_id: string; merchant_name: string; last_sale_at: Date | null }>(
    `SELECT m.merchant_id, m.name AS merchant_name,
            (SELECT max(e.occurred_at) FROM sale_events e WHERE e.merchant_id = m.merchant_id AND e.type = 'sale.completed') AS last_sale_at
       FROM merchants m JOIN merchant_onboarding o ON o.merchant_id = m.merchant_id
      WHERE o.status = 'live'`,
  );
  const day = 86_400_000;
  const active = live.filter((m) => m.last_sale_at && now.getTime() - new Date(m.last_sale_at).getTime() < 7 * day);
  const quiet = live.filter((m) => !m.last_sale_at || now.getTime() - new Date(m.last_sale_at).getTime() >= 14 * day);
  const { rows: regs } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM registers WHERE status = 'active'");
  const { rows: support } = await q.query<{ recent: number; unread: number }>(
    `SELECT count(*) FILTER (WHERE author_kind = 'merchant_user' AND created_at > $1::timestamptz - interval '7 days')::int AS recent,
            count(*) FILTER (WHERE author_kind = 'merchant_user' AND created_at > coalesce((SELECT last_read_at FROM support_reads r WHERE r.merchant_id = s.merchant_id AND r.side = 'admin'), '-infinity'))::int AS unread
       FROM support_messages s`,
    [now.toISOString()],
  );
  const { rows: installs } = await q.query<{ week: string; registers: number }>(
    `SELECT to_char(date_trunc('week', paired_at AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS week, count(*)::int AS registers
       FROM registers WHERE paired_at > $1::timestamptz - interval '8 weeks'
      GROUP BY 1 ORDER BY 1`,
    [now.toISOString()],
  );
  const sum = (f: (r: ResidualRow) => number) => report.reduce((n, r) => n + f(r), 0);
  const card = sum((r) => Math.max(0, r.card_volume_cents));
  const withCost = report.filter((r) => r.cost_entered);
  return {
    as_of: now.toISOString(),
    stores_live: live.length,
    stores_active_7d: active.length,
    stores_quiet_14d: quiet.map((m) => ({ merchant_id: m.merchant_id, merchant_name: m.merchant_name, last_sale_at: m.last_sale_at ? new Date(m.last_sale_at).toISOString() : null })),
    registers_paired: regs[0]!.n,
    month,
    volume_cents: card + sum((r) => r.cash_volume_cents),
    card_volume_cents: card,
    revenue_cents: sum((r) => r.revenue_cents),
    // Margin only over merchants whose cost is in; null until at least one is.
    margin_cents: withCost.length ? withCost.reduce((n, r) => n + (r.margin_cents ?? 0), 0) : null,
    effective_rate_ppm: ratePpm(sum((r) => r.processing_revenue_cents), card),
    support_messages_7d: support[0]!.recent,
    support_unread: support[0]!.unread,
    installs_by_week: installs,
  };
}
