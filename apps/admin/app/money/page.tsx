'use client';
/**
 * AD Pay's own numbers (build plan P13, ADR 0022): KPIs, the residual/margin report per merchant per
 * month, and the statement analyzer for prospects. Processor cost and statement figures are typed
 * in until Finix data and statement parsers exist (⛔). Dollars/percent typed as text and parsed to
 * integer cents/ppm; nothing here does float math on money.
 */
import {
  PLAN_KIND_LABELS,
  StatementInput,
  analyzeStatement,
  cents,
  formatUsd,
  parseUsdToCents,
  percentToPpm,
  ppmToPercent,
  type Kpis,
  type PricingPlan,
  type ResidualRow,
} from '@adpay/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { describePlan } from '../../components/pricing-panel';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

const usd = (c: number) => formatUsd(cents(c));
const pct = (ppm: number | null) => (ppm === null ? '—' : `${ppmToPercent(ppm)}%`);
const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);

export default function MoneyPage() {
  const [tab, setTab] = useState<'kpis' | 'residuals' | 'analyzer'>('kpis');
  return (
    <Shell>
      <h1>Money</h1>
      <div className="tabs">
        {(
          [
            ['kpis', 'KPIs'],
            ['residuals', 'Residuals & margin'],
            ['analyzer', 'Statement analyzer'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'kpis' && <KpiView />}
      {tab === 'residuals' && <Residuals />}
      {tab === 'analyzer' && <Analyzer />}
    </Shell>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

function KpiView() {
  const k = useLoad(() => api<Kpis>('/admin/kpis'), []);
  if (k.error) return <ErrorBox error={k.error} />;
  if (!k.data) return null;
  const d = k.data;
  return (
    <>
      <div className="grid4">
        <Stat label="Stores live" value={String(d.stores_live)} sub={`${d.stores_active_7d} sold in the last 7 days`} />
        <Stat label="Registers paired" value={String(d.registers_paired)} />
        <Stat label={`Volume ${d.month}`} value={usd(d.volume_cents)} sub={`${usd(d.card_volume_cents)} on card`} />
        <Stat label="Our revenue" value={usd(d.revenue_cents)} sub={`effective ${pct(d.effective_rate_ppm)} of card volume`} />
        <Stat label="Margin" value={d.margin_cents === null ? '—' : usd(d.margin_cents)} sub={d.margin_cents === null ? 'enter processor costs under Residuals' : 'stores with cost entered'} />
        <Stat label="Support" value={`${d.support_unread} unread`} sub={`${d.support_messages_7d} messages from stores in 7 days`} />
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>Quiet stores (no sale in 14 days)</h2>
          {d.stores_quiet_14d.length === 0 ? (
            <p className="muted">None. Every live store is selling.</p>
          ) : (
            <ul>
              {d.stores_quiet_14d.map((s) => (
                <li key={s.merchant_id}>
                  <Link href={`/merchants/${s.merchant_id}`}>{s.merchant_name}</Link>{' '}
                  <span className="muted tiny">{s.last_sale_at ? `last sale ${new Date(s.last_sale_at).toLocaleDateString()}` : 'never sold'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h2>Installs per week</h2>
          {d.installs_by_week.length === 0 ? (
            <p className="muted">No registers paired in the last 8 weeks.</p>
          ) : (
            <table>
              <tbody>
                {d.installs_by_week.map((w) => (
                  <tr key={w.week}>
                    <td>Week of {w.week}</td>
                    <td className="num">{w.registers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function Residuals() {
  const [month, setMonth] = useState(thisMonth());
  const r = useLoad(() => api<{ rows: ResidualRow[] }>(`/admin/residuals?month=${month}`), [month]);
  const [editing, setEditing] = useState<string | null>(null);
  const [cost, setCost] = useState({ interchange: '', fees: '', note: '' });
  const [error, setError] = useState<unknown>(null);

  async function saveCost(merchantId: string) {
    setError(null);
    try {
      await api(`/admin/merchants/${merchantId}/processor-cost`, {
        method: 'PUT',
        body: { month, interchange_cents: parseUsdToCents(cost.interchange), processor_fees_cents: parseUsdToCents(cost.fees), note: cost.note.trim() || null },
      });
      setEditing(null);
      r.reload();
    } catch (e) {
      setError(e);
    }
  }

  const rows = r.data?.rows ?? [];
  const total = (f: (x: ResidualRow) => number) => rows.reduce((n, x) => n + f(x), 0);
  return (
    <div className="panel">
      <div className="toolbar">
        <label className="field">
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <span className="muted tiny">
          Volume from the sale ledger (card net of card refunds); revenue from the plan in force at month end. Processor cost is typed from the processor’s
          statement until Finix data can be imported.
        </span>
      </div>
      <ErrorBox error={r.error ?? error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Plan</th>
              <th className="num">Card volume</th>
              <th className="num">Txns</th>
              <th className="num">Processing</th>
              <th className="num">Subscription</th>
              <th className="num">Revenue</th>
              <th className="num">Cost</th>
              <th className="num">Margin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.merchant_id}>
                <td>
                  <Link href={`/merchants/${x.merchant_id}`}>{x.merchant_name}</Link>
                </td>
                <td>{x.plan_kind ? PLAN_KIND_LABELS[x.plan_kind] : <span className="pill warn">no plan</span>}</td>
                <td className="num">{usd(x.card_volume_cents)}</td>
                <td className="num">{x.card_transactions}</td>
                <td className="num">{usd(x.processing_revenue_cents)}</td>
                <td className="num">{usd(x.subscription_revenue_cents)}</td>
                <td className="num">
                  <strong>{usd(x.revenue_cents)}</strong>
                </td>
                <td className="num">{x.cost_cents === null ? '—' : usd(x.cost_cents)}</td>
                <td className="num">{x.margin_cents === null ? '—' : usd(x.margin_cents)}</td>
                <td>
                  {editing === x.merchant_id ? (
                    <span className="inline">
                      <input placeholder="Interchange $" value={cost.interchange} onChange={(e) => setCost({ ...cost, interchange: e.target.value })} style={{ width: 100 }} />
                      <input placeholder="Processor fees $" value={cost.fees} onChange={(e) => setCost({ ...cost, fees: e.target.value })} style={{ width: 110 }} />
                      <input placeholder="Note" value={cost.note} onChange={(e) => setCost({ ...cost, note: e.target.value })} style={{ width: 120 }} />
                      <button className="primary" onClick={() => void saveCost(x.merchant_id)}>
                        Save
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setCost({ interchange: '', fees: '', note: '' });
                        setEditing(x.merchant_id);
                      }}
                    >
                      {x.cost_entered ? 'Correct cost' : 'Enter cost'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2}>
                <strong>Total</strong>
              </td>
              <td className="num">{usd(total((x) => x.card_volume_cents))}</td>
              <td className="num">{total((x) => x.card_transactions)}</td>
              <td className="num">{usd(total((x) => x.processing_revenue_cents))}</td>
              <td className="num">{usd(total((x) => x.subscription_revenue_cents))}</td>
              <td className="num">
                <strong>{usd(total((x) => x.revenue_cents))}</strong>
              </td>
              <td className="num">{usd(total((x) => x.cost_cents ?? 0))}</td>
              <td className="num">{usd(total((x) => x.margin_cents ?? 0))}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Saved {
  analysis_id: string;
  entry: { prospect: string; processor: string; month: string };
  analysis: { effective_rate_ppm: number; quotes: { saving_cents: number }[] };
  created_at: string;
}

function Analyzer() {
  const list = useLoad(() => api<{ analyses: Saved[] }>('/admin/analyzer'), []);
  const [f, setF] = useState({
    prospect: '',
    processor: 'Clover',
    month: thisMonth(),
    volume: '',
    txns: '',
    fees: '',
    interchange: '',
    pos: '0',
    registers: '1',
    dual: '4',
    monthly: '49.00',
    offerFlat: false,
    flatRate: '2.6',
    perTxn: '0.10',
  });
  const [error, setError] = useState<unknown>(null);

  const parsed = useMemo(() => {
    try {
      const today = new Date().toLocaleDateString('en-CA');
      const offers: PricingPlan[] = [{ kind: 'dual_pricing', dual_price_rate_ppm: percentToPpm(f.dual), monthly_cents: parseUsdToCents(f.monthly), per_register_cents: 0, effective_from: today, note: null }];
      if (f.offerFlat) offers.push({ kind: 'flat', rate_ppm: percentToPpm(f.flatRate), per_txn_cents: parseUsdToCents(f.perTxn), monthly_cents: parseUsdToCents(f.monthly), per_register_cents: 0, effective_from: today, note: null });
      const entry = StatementInput.parse({
        prospect: f.prospect,
        processor: f.processor,
        month: f.month,
        card_volume_cents: parseUsdToCents(f.volume),
        transactions: Number(f.txns),
        total_fees_cents: parseUsdToCents(f.fees),
        interchange_cents: f.interchange.trim() ? parseUsdToCents(f.interchange) : null,
        pos_fees_cents: parseUsdToCents(f.pos || '0'),
        registers: Number(f.registers),
        offers,
      });
      return { ok: true as const, entry, analysis: analyzeStatement(entry, entry.offers) };
    } catch (e) {
      return { ok: false as const, message: (e as { issues?: { message: string; path: (string | number)[] }[] }).issues?.[0]?.message ?? (e as Error).message };
    }
  }, [f]);

  async function save() {
    if (!parsed.ok) return;
    setError(null);
    try {
      const r = await api<{ analysis_id: string }>('/admin/analyzer', { method: 'POST', body: parsed.entry });
      window.open(`/money/analysis/${r.analysis_id}`, '_blank');
      list.reload();
    } catch (e) {
      setError(e);
    }
  }

  const field = (label: string, key: keyof typeof f, hint?: string) => (
    <label className="field">
      {label} {hint && <span className="muted">{hint}</span>}
      <input value={String(f[key])} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="grid2">
      <div className="panel">
        <h2>From their statement</h2>
        <p className="muted tiny">Type the figures from one month’s statement. Uploading the PDF for automatic reading comes once we have sample statements from each processor.</p>
        <div className="form-grid">
          {field('Store', 'prospect')}
          {field('Processor today', 'processor')}
          <label className="field">
            Statement month
            <input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
          </label>
          {field('Card volume ($)', 'volume')}
          {field('Transactions', 'txns')}
          {field('Total card fees ($)', 'fees')}
          {field('Interchange + assessments ($)', 'interchange', '(if shown)')}
          {field('POS / software per month ($)', 'pos')}
          {field('Registers', 'registers')}
        </div>
        <h3>Our offer</h3>
        <div className="form-grid">
          {field('Dual pricing: card price + %', 'dual')}
          {field('Subscription per month ($)', 'monthly')}
          <label className="check span2">
            <input type="checkbox" checked={f.offerFlat} onChange={(e) => setF({ ...f, offerFlat: e.target.checked })} /> Also quote a flat rate
          </label>
          {f.offerFlat && field('Flat rate %', 'flatRate')}
          {f.offerFlat && field('+ per transaction ($)', 'perTxn')}
        </div>
        <ErrorBox error={error ?? (parsed.ok || !f.volume ? null : new Error(parsed.message))} />
        <div className="actions-row">
          <button className="primary" disabled={!parsed.ok} onClick={() => void save()}>
            Save & open one-pager
          </button>
        </div>
      </div>
      <div className="panel">
        <h2>Result</h2>
        {parsed.ok ? (
          <>
            <div className="grid4">
              <Stat label="They pay today" value={usd(parsed.analysis.today_total_cents)} sub="per month, fees + POS" />
              <Stat label="Effective rate" value={pct(parsed.analysis.effective_rate_ppm)} />
              <Stat label="Markup over interchange" value={pct(parsed.analysis.markup_rate_ppm)} sub={parsed.analysis.markup_cents === null ? 'needs interchange' : usd(parsed.analysis.markup_cents)} />
            </div>
            {parsed.analysis.quotes.map((q, i) => (
              <div key={i} className="panel">
                <strong>{describePlan(q.plan)}</strong>
                <div>
                  Costs {usd(q.merchant_cost_cents)} a month ·{' '}
                  {q.saving_cents > 0 ? <span className="money approved">saves {usd(q.saving_cents)} a month ({usd(q.saving_cents * 12)} a year)</span> : <span>no saving</span>}
                </div>
                {q.note && <div className="tiny muted">{q.note}</div>}
              </div>
            ))}
          </>
        ) : (
          <p className="muted">Fill in the statement figures to see the comparison.</p>
        )}
        <h3>Saved</h3>
        <ul>
          {list.data?.analyses.map((a) => (
            <li key={a.analysis_id}>
              <Link href={`/money/analysis/${a.analysis_id}`} target="_blank">
                {a.entry.prospect}
              </Link>{' '}
              <span className="muted tiny">
                {a.entry.processor} · {a.entry.month} · {pct(a.analysis.effective_rate_ppm)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
