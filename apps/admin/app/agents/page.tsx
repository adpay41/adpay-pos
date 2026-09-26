'use client';
/**
 * Agents and referral partners (Bible 3.1; P25b, ADR 0040): who they are, their referral code, their
 * dated terms, the stores they brought, and the month's statement — each store's share of revenue
 * or margin (from the residual report) plus the bounty for stores that made their first sale that
 * month. The CSV is what's paid; paying it happens outside the system.
 */
import { AGENT_KIND_KEYS, AGENT_KINDS, AgentInput, AgentTermsInput, cents, formatUsd, percentToPpm, ppmToPercent, parseUsdToCents, SPLIT_BASES, type AgentKind, type AgentStatement, type SplitBasis } from '@adpay/shared';
import { useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { API_URL, api, getToken } from '../../lib/api';

const usd = (c: number | null) => (c === null ? '—' : formatUsd(cents(c)));
const thisMonth = () => new Date().toISOString().slice(0, 7);
const firstOfMonth = () => `${thisMonth()}-01`;

interface Terms {
  effective_from: string;
  basis: SplitBasis;
  split_ppm: number;
  bounty_cents: number;
}
interface Agent {
  agent_id: string;
  name: string;
  kind: AgentKind;
  email: string | null;
  referral_code: string;
  active: boolean;
  terms: Terms[];
  stores: { merchant_id: string; merchant_name: string; since: string }[];
}

export default function AgentsPage() {
  const agents = useLoad(() => api<{ agents: Agent[] }>('/admin/agents'), []);
  const [month, setMonth] = useState(thisMonth());
  const statements = useLoad(() => api<{ statements: AgentStatement[] }>(`/admin/agents/statements?month=${month}`), [month]);
  const [error, setError] = useState<unknown>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      agents.reload();
      statements.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function downloadCsv() {
    const res = await fetch(`${API_URL}/admin/agents/statements.csv?month=${month}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-statements-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <h1>Agents</h1>
      <ErrorBox error={error ?? agents.error} />
      <div className="panel">
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Statements</h2>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button onClick={() => void downloadCsv()}>Download CSV</button>
        </div>
        <ErrorBox error={statements.error} />
        {statements.data?.statements.length === 0 ? <p className="muted">No agent has stores in {month}.</p> : null}
        {statements.data?.statements.map((s) => (
          <div key={s.agent_id} style={{ marginTop: 10 }}>
            <strong>{s.agent_name}</strong> <span className="muted tiny">{AGENT_KINDS[s.kind]}</span> — <strong>{usd(s.total_cents)}</strong>
            <span className="tiny muted">
              {' '}
              ({usd(s.residual_cents)} residual + {usd(s.bounty_cents)} bounties{s.pending ? `; ${s.pending} store${s.pending === 1 ? '' : 's'} waiting for processor cost` : ''})
            </span>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Split</th>
                    <th className="num">Card volume</th>
                    <th className="num">Revenue</th>
                    <th className="num">Margin</th>
                    <th className="num">Residual</th>
                    <th className="num">Bounty</th>
                  </tr>
                </thead>
                <tbody>
                  {s.lines.map((l) => (
                    <tr key={l.merchant_id}>
                      <td>{l.merchant_name}</td>
                      <td className="tiny">
                        {ppmToPercent(l.split_ppm)}% of {l.basis}
                      </td>
                      <td className="num">{usd(l.card_volume_cents)}</td>
                      <td className="num">{usd(l.revenue_cents)}</td>
                      <td className="num">{usd(l.margin_cents)}</td>
                      <td className="num">{l.residual_cents === null ? <span className="muted">cost not entered</span> : usd(l.residual_cents)}</td>
                      <td className="num">{l.bounty_cents ? usd(l.bounty_cents) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Agents & partners</h2>
        {agents.data?.agents.map((a) => (
          <AgentCard key={a.agent_id} a={a} run={run} />
        ))}
      </div>
      <NewAgent run={run} />
    </Shell>
  );
}

function termsText(t: Terms) {
  return `${ppmToPercent(t.split_ppm)}% of ${t.basis}${t.bounty_cents ? ` + ${usd(t.bounty_cents)} per store going live` : ''} from ${t.effective_from}`;
}

function TermsFields({ v, set }: { v: { from: string; basis: SplitBasis; pct: string; bounty: string }; set: (p: Partial<{ from: string; basis: SplitBasis; pct: string; bounty: string }>) => void }) {
  return (
    <>
      <label className="field">
        From (first of a month)
        <input value={v.from} onChange={(e) => set({ from: e.target.value })} placeholder="YYYY-MM-01" />
      </label>
      <label className="field">
        Basis
        <select value={v.basis} onChange={(e) => set({ basis: e.target.value as SplitBasis })}>
          {(Object.keys(SPLIT_BASES) as SplitBasis[]).map((b) => (
            <option key={b} value={b}>
              {SPLIT_BASES[b]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Split %
        <input value={v.pct} onChange={(e) => set({ pct: e.target.value })} placeholder="20" />
      </label>
      <label className="field">
        Bounty per store ($)
        <input value={v.bounty} onChange={(e) => set({ bounty: e.target.value })} placeholder="0" />
      </label>
    </>
  );
}

function parseTerms(v: { from: string; basis: SplitBasis; pct: string; bounty: string }) {
  try {
    return AgentTermsInput.safeParse({ effective_from: v.from, basis: v.basis, split_ppm: percentToPpm(v.pct || '0'), bounty_cents: parseUsdToCents(v.bounty || '0') });
  } catch {
    return null;
  }
}

function AgentCard({ a, run }: { a: Agent; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState({ from: firstOfMonth(), basis: 'margin' as SplitBasis, pct: '', bounty: '' });
  const parsed = parseTerms(t);
  const current = a.terms.at(-1);
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }} className={a.active ? '' : 'muted'}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{a.name}</strong>
        <span className="tiny muted">{AGENT_KINDS[a.kind]}</span>
        <span className="mono tiny">{a.referral_code}</span>
        <span className="tiny">{current ? termsText(current) : 'no terms'}</span>
        <span className="tiny muted">
          {a.stores.length} store{a.stores.length === 1 ? '' : 's'}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(!open)}>{open ? 'Close' : 'Details'}</button>
        <button onClick={() => void run(() => api(`/admin/agents/${a.agent_id}/active`, { method: 'POST', body: { active: !a.active } }))}>{a.active ? 'Deactivate' : 'Activate'}</button>
      </div>
      {open ? (
        <div style={{ paddingLeft: 12 }}>
          <div className="tiny">Stores: {a.stores.map((s) => `${s.merchant_name} (since ${s.since})`).join(', ') || '—'}</div>
          <div className="tiny muted">Terms history: {a.terms.map(termsText).join(' → ')}</div>
          <div className="form-grid">
            <TermsFields v={t} set={(p) => setT({ ...t, ...p })} />
            <div className="span2">
              <button disabled={!parsed?.success} onClick={() => parsed?.success && void run(() => api(`/admin/agents/${a.agent_id}/terms`, { method: 'POST', body: parsed.data }))}>
                Add new terms
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewAgent({ run }: { run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [f, setF] = useState({ name: '', kind: 'agent' as AgentKind, email: '', code: '' });
  const [t, setT] = useState({ from: firstOfMonth(), basis: 'margin' as SplitBasis, pct: '', bounty: '' });
  const agent = AgentInput.safeParse({ name: f.name, kind: f.kind, email: f.email.trim() || null, phone: null, referral_code: f.code });
  const terms = parseTerms(t);
  return (
    <div className="panel">
      <h2>Add an agent or partner</h2>
      <div className="form-grid">
        <label className="field">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          Kind
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as AgentKind })}>
            {AGENT_KIND_KEYS.map((k) => (
              <option key={k} value={k}>
                {AGENT_KINDS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Email
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="field">
          Referral code
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={12} placeholder="e.g. RAVI01" />
        </label>
        <TermsFields v={t} set={(p) => setT({ ...t, ...p })} />
        <div className="span2">
          <button className="primary" disabled={!agent.success || !terms?.success} onClick={() => agent.success && terms?.success && void run(() => api('/admin/agents', { method: 'POST', body: { agent: agent.data, terms: terms.data } }))}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
