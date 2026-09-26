/**
 * Referral partners and sales agents (Bible 3.1; P25b, ADR 0040): who brought which store, on what
 * terms, and what each is owed for a month — computed from the residual report (ADR 0022) with the
 * terms and the assignment in force at month end. Nothing about a payout is typed or stored; the
 * statement is recomputed from the ledger every time. Paying agents happens outside the system.
 */
import { agentLine, inForce, type AgentInput, type AgentKind, type AgentStatement, type AgentTerms, type MerchantAgentInput } from '@adpay/shared';
import type { z } from 'zod';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { residualReport } from './money';

type MerchantAgent = z.infer<typeof MerchantAgentInput>;

const firstOfMonth = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export interface AgentRow {
  agent_id: string;
  name: string;
  kind: AgentKind;
  email: string | null;
  phone: string | null;
  referral_code: string;
  active: boolean;
  terms: (AgentTerms & { created_at: string })[];
  stores: { merchant_id: string; merchant_name: string; since: string }[];
}

interface TermsRow {
  agent_id: string;
  effective_from: string;
  basis: 'margin' | 'revenue';
  split_ppm: number;
  bounty_cents: string | number;
  created_at: Date;
}
interface AssignmentRow {
  merchant_id: string;
  merchant_name: string;
  agent_id: string | null;
  effective_from: string;
  created_at: Date;
}

async function allTerms(q: Queryable): Promise<Map<string, (AgentTerms & { created_at: string })[]>> {
  const { rows } = await q.query<TermsRow>(
    "SELECT agent_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, basis, split_ppm, bounty_cents, created_at FROM agent_terms ORDER BY effective_from, created_at",
  );
  const out = new Map<string, (AgentTerms & { created_at: string })[]>();
  for (const r of rows) {
    out.set(r.agent_id, [...(out.get(r.agent_id) ?? []), { effective_from: r.effective_from, basis: r.basis, split_ppm: r.split_ppm, bounty_cents: Number(r.bounty_cents), created_at: r.created_at.toISOString() }]);
  }
  return out;
}

async function allAssignments(q: Queryable): Promise<Map<string, { merchant_name: string; rows: { agent_id: string | null; effective_from: string; created_at: string }[] }>> {
  const { rows } = await q.query<AssignmentRow>(
    `SELECT a.merchant_id, m.name AS merchant_name, a.agent_id, to_char(a.effective_from, 'YYYY-MM-DD') AS effective_from, a.created_at
       FROM merchant_agents a JOIN merchants m ON m.merchant_id = a.merchant_id ORDER BY a.effective_from, a.created_at`,
  );
  const out = new Map<string, { merchant_name: string; rows: { agent_id: string | null; effective_from: string; created_at: string }[] }>();
  for (const r of rows) {
    const cur = out.get(r.merchant_id) ?? { merchant_name: r.merchant_name, rows: [] };
    cur.rows.push({ agent_id: r.agent_id, effective_from: r.effective_from, created_at: r.created_at.toISOString() });
    out.set(r.merchant_id, cur);
  }
  return out;
}

export async function listAgents(q: Queryable): Promise<AgentRow[]> {
  const { rows } = await q.query<Omit<AgentRow, 'terms' | 'stores'>>('SELECT agent_id, name, kind, email, phone, referral_code, active FROM agents ORDER BY active DESC, name');
  const terms = await allTerms(q);
  const assignments = await allAssignments(q);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((a) => ({
    ...a,
    terms: terms.get(a.agent_id) ?? [],
    stores: [...assignments.entries()]
      .map(([merchant_id, v]) => ({ merchant_id, merchant_name: v.merchant_name, current: inForce(v.rows, today) }))
      .filter((s) => s.current?.agent_id === a.agent_id)
      .map((s) => ({ merchant_id: s.merchant_id, merchant_name: s.merchant_name, since: s.current!.effective_from })),
  }));
}

export async function createAgent(db: Db, actor: AdminPrincipal, input: AgentInput, terms: AgentTerms, traceId: string): Promise<{ agent_id: string }> {
  return db.tx(async (q) => {
    const { rows: dup } = await q.query('SELECT 1 FROM agents WHERE referral_code = $1', [input.referral_code]);
    if (dup.length) throw badRequest('That referral code is taken');
    const { rows } = await q.query<{ agent_id: string }>(
      'INSERT INTO agents (name, kind, email, phone, referral_code, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING agent_id',
      [input.name, input.kind, input.email, input.phone, input.referral_code, actor.user_id],
    );
    const id = rows[0]!.agent_id;
    await insertTerms(q, actor, id, terms);
    await audit(q, { actor, action: 'agent.created', target: id, details: { ...input, terms }, trace_id: traceId });
    return { agent_id: id };
  });
}

async function insertTerms(q: Queryable, actor: AdminPrincipal, agentId: string, t: AgentTerms): Promise<void> {
  await q.query('INSERT INTO agent_terms (agent_id, effective_from, basis, split_ppm, bounty_cents, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
    agentId,
    t.effective_from,
    t.basis,
    t.split_ppm,
    t.bounty_cents,
    actor.user_id,
  ]);
}

export async function addTerms(db: Db, actor: AdminPrincipal, agentId: string, t: AgentTerms, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query('SELECT 1 FROM agents WHERE agent_id = $1', [agentId]);
    if (!rows.length) throw notFound('Agent not found');
    await insertTerms(q, actor, agentId, t);
    await audit(q, { actor, action: 'agent.terms_added', target: agentId, details: t, trace_id: traceId });
  });
}

export async function setAgentActive(db: Db, actor: AdminPrincipal, agentId: string, active: boolean, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query('UPDATE agents SET active = $2 WHERE agent_id = $1 RETURNING agent_id', [agentId, active]);
    if (!rows.length) throw notFound('Agent not found');
    await audit(q, { actor, action: active ? 'agent.activated' : 'agent.deactivated', target: agentId, trace_id: traceId });
  });
}

export async function assignAgent(q: Queryable, actor: AdminPrincipal, merchantId: string, input: MerchantAgent, traceId: string): Promise<void> {
  const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  if (input.agent_id) {
    const { rows: a } = await q.query<{ active: boolean }>('SELECT active FROM agents WHERE agent_id = $1', [input.agent_id]);
    if (!a[0]) throw badRequest('Agent not found');
    if (!a[0].active) throw badRequest('That agent is inactive');
  }
  await q.query('INSERT INTO merchant_agents (org_id, merchant_id, agent_id, effective_from, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
    rows[0].org_id,
    merchantId,
    input.agent_id,
    input.effective_from,
    input.note,
    actor.user_id,
  ]);
  await audit(q, { actor, action: 'merchant.agent_assigned', tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: merchantId, details: input, trace_id: traceId });
}

/** Onboarding with a referral code: the store belongs to that agent from this month. */
export async function assignByReferralCode(q: Queryable, actor: AdminPrincipal, merchantId: string, code: string, traceId: string): Promise<void> {
  const { rows } = await q.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE referral_code = $1 AND active', [code.toUpperCase()]);
  if (!rows[0]) throw badRequest(`No active agent has the referral code ${code.toUpperCase()}`);
  await assignAgent(q, actor, merchantId, { agent_id: rows[0].agent_id, effective_from: firstOfMonth(), note: `Referral code ${code.toUpperCase()}` }, traceId);
}

export async function merchantAgentHistory(q: Queryable, merchantId: string): Promise<{ agent_id: string | null; agent_name: string | null; effective_from: string; note: string | null; created_at: string }[]> {
  const { rows } = await q.query<{ agent_id: string | null; agent_name: string | null; effective_from: string; note: string | null; created_at: Date }>(
    `SELECT a.agent_id, g.name AS agent_name, to_char(a.effective_from, 'YYYY-MM-DD') AS effective_from, a.note, a.created_at
       FROM merchant_agents a LEFT JOIN agents g ON g.agent_id = a.agent_id WHERE a.merchant_id = $1 ORDER BY a.effective_from DESC, a.created_at DESC`,
    [merchantId],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

/**
 * Every agent's statement for a month: the stores assigned to them at month end, each store's
 * residual under the terms in force at month end, and the bounty for stores whose first sale was
 * this month.
 */
export async function agentStatements(q: Queryable, month: string): Promise<AgentStatement[]> {
  const end = monthEnd(month);
  const residuals = new Map((await residualReport(q, month)).map((r) => [r.merchant_id, r]));
  const terms = await allTerms(q);
  const assignments = await allAssignments(q);
  const { rows: firsts } = await q.query<{ merchant_id: string }>(
    `SELECT merchant_id FROM sale_events WHERE type = 'sale.completed' GROUP BY merchant_id
     HAVING to_char(min(business_date), 'YYYY-MM') = $1`,
    [month],
  );
  const firstSale = new Set(firsts.map((r) => r.merchant_id));
  const { rows: agents } = await q.query<{ agent_id: string; name: string; kind: AgentKind }>('SELECT agent_id, name, kind FROM agents ORDER BY name');

  return agents
    .map((a) => {
      const lines = [];
      for (const [merchantId, v] of assignments) {
        if (inForce(v.rows, end)?.agent_id !== a.agent_id) continue;
        const t = inForce(terms.get(a.agent_id) ?? [], end);
        const r = residuals.get(merchantId);
        if (!t || !r) continue;
        lines.push(agentLine(r, t, firstSale.has(merchantId)));
      }
      lines.sort((x, y) => x.merchant_name.localeCompare(y.merchant_name));
      const residual = lines.reduce((s, l) => s + (l.residual_cents ?? 0), 0);
      const bounty = lines.reduce((s, l) => s + l.bounty_cents, 0);
      return {
        agent_id: a.agent_id,
        agent_name: a.name,
        kind: a.kind,
        month,
        lines,
        residual_cents: residual,
        bounty_cents: bounty,
        total_cents: residual + bounty,
        pending: lines.filter((l) => l.residual_cents === null).length,
      };
    })
    .filter((s) => s.lines.length > 0);
}
