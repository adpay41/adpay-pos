'use client';
/**
 * Investor / bank pack and cohorts (Bible 3.5; P25c, ADR 0041): the business on one printable page —
 * stores, volume, revenue and margin by month for the last 12 months, store cohorts by first-sale
 * month with retention — all derived from the ledger on the date shown. "Print / save as PDF" uses
 * the browser; the monthly table downloads as CSV for a model.
 */
import { cents, formatUsd, type Kpis } from '@adpay/shared';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { API_URL, api, getToken } from '../../lib/api';

interface PackMonth {
  month: string;
  stores_started: number;
  stores_active: number;
  sales_cents: number;
  card_volume_cents: number;
  revenue_cents: number;
  subscription_revenue_cents: number;
  processing_revenue_cents: number;
  margin_cents: number | null;
  margin_stores: number;
}
interface Cohort {
  cohort: string;
  stores: number;
  months: { offset: number; month: string; active: number; retention_tenths: number; sales_cents: number }[];
}
interface Pack {
  as_of: string;
  kpis: Kpis;
  months: PackMonth[];
  cohorts: Cohort[];
  retention: { m1: number | null; m3: number | null; m6: number | null };
  notes: string[];
}

const usd = (c: number | null) => (c === null ? '—' : formatUsd(cents(c)));
const pct = (t: number | null) => (t === null ? '—' : `${Math.floor(t / 10)}.${t % 10}%`);

export default function InvestorPage() {
  const pack = useLoad(() => api<Pack>('/admin/investor-pack'), []);
  const p = pack.data;

  async function csv() {
    const res = await fetch(`${API_URL}/admin/investor-pack.csv`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `adpay-monthly-${p?.kpis.month ?? ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const last = p?.months.at(-1);
  const prev = p?.months.at(-2);
  return (
    <Shell>
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button className="primary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
        <button onClick={() => void csv()}>Monthly table (CSV)</button>
      </div>
      <ErrorBox error={pack.error} />
      {p ? (
        <div className="print-page">
          <h1>American Dream Pay — company snapshot</h1>
          <p className="muted">As of {new Date(p.as_of).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}. Derived from the register ledger; see notes.</p>

          <div className="cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <Stat label="Stores live" value={String(p.kpis.stores_live)} sub={`${p.kpis.stores_active_7d} sold in the last 7 days`} />
            <Stat label="Registers paired" value={String(p.kpis.registers_paired)} />
            <Stat label={`Sales, ${last?.month ?? ''}`} value={usd(last?.sales_cents ?? 0)} sub={prev ? `${usd(prev.sales_cents)} the month before` : undefined} />
            <Stat label={`Revenue, ${last?.month ?? ''}`} value={usd(last?.revenue_cents ?? 0)} sub={`${usd(last?.subscription_revenue_cents ?? 0)} subscriptions`} />
            <Stat label="Retention" value={pct(p.retention.m1)} sub={`month 1 · ${pct(p.retention.m3)} month 3 · ${pct(p.retention.m6)} month 6`} />
          </div>

          <h2>By month</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Stores started</th>
                  <th className="num">Active</th>
                  <th className="num">Sales</th>
                  <th className="num">Card volume</th>
                  <th className="num">Revenue</th>
                  <th className="num">of which subscriptions</th>
                  <th className="num">Margin*</th>
                </tr>
              </thead>
              <tbody>
                {p.months.map((m) => (
                  <tr key={m.month}>
                    <td>{m.month}</td>
                    <td className="num">{m.stores_started}</td>
                    <td className="num">{m.stores_active}</td>
                    <td className="num">{usd(m.sales_cents)}</td>
                    <td className="num">{usd(m.card_volume_cents)}</td>
                    <td className="num">{usd(m.revenue_cents)}</td>
                    <td className="num">{usd(m.subscription_revenue_cents)}</td>
                    <td className="num">
                      {usd(m.margin_cents)}
                      {m.margin_cents !== null ? <span className="tiny muted"> ({m.margin_stores})</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Cohorts</h2>
          <p className="tiny muted">Stores by the month of their first sale; the share still selling in each month after.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th className="num">Stores</th>
                  {Array.from({ length: Math.max(1, ...p.cohorts.map((c) => c.months.length)) }, (_, i) => (
                    <th key={i} className="num">
                      M{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.cohorts.map((c) => (
                  <tr key={c.cohort}>
                    <td>{c.cohort}</td>
                    <td className="num">{c.stores}</td>
                    {c.months.map((m) => (
                      <td key={m.offset} className="num" title={`${m.active} active, ${usd(m.sales_cents)}`}>
                        {pct(m.retention_tenths)}
                      </td>
                    ))}
                  </tr>
                ))}
                {p.cohorts.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No store has made a sale yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <h2>Notes</h2>
          <ul className="tiny">
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>* Margin in parentheses: number of stores whose processor cost is entered for that month.</li>
          </ul>
        </div>
      ) : null}
    </Shell>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <div className="tiny muted">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
      {sub ? <div className="tiny muted">{sub}</div> : null}
    </div>
  );
}
