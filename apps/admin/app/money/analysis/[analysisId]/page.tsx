'use client';
/**
 * The one-page comparison to hand a store owner (build plan P13, Bible 3.1 L41). Print → "Save as
 * PDF" gives the PDF; the page is laid out to fit one Letter sheet. Figures come from the saved entry
 * and the shared integer math, so the printout matches the analyzer exactly.
 */
import { cents, formatUsd, ppmToPercent, type PricingPlan, type StatementAnalysis } from '@adpay/shared';
import { useParams } from 'next/navigation';
import { describePlan } from '../../../../components/pricing-panel';
import { ErrorBox, Shell, useLoad } from '../../../../components/ui';
import { api } from '../../../../lib/api';

const usd = (c: number) => formatUsd(cents(c));
const pct = (ppm: number | null) => (ppm === null ? '—' : `${ppmToPercent(ppm)}%`);

interface Saved {
  entry: { prospect: string; processor: string; month: string; card_volume_cents: number; transactions: number; total_fees_cents: number; pos_fees_cents: number; offers: PricingPlan[] };
  analysis: StatementAnalysis;
  created_by_name: string | null;
}

export default function AnalysisPage() {
  const { analysisId } = useParams<{ analysisId: string }>();
  const a = useLoad(() => api<Saved>(`/admin/analyzer/${analysisId}`), [analysisId]);
  const best = a.data?.analysis.quotes.reduce((x, y) => (y.saving_cents > x.saving_cents ? y : x));
  return (
    <Shell>
      <ErrorBox error={a.error} />
      {a.data && best && (
        <div className="onepager">
          <div className="no-print actions-row">
            <button className="primary" onClick={() => window.print()}>
              Print / save as PDF
            </button>
          </div>
          <div className="kit-brand">
            <span className="brand-mark">AD</span> Pay — what you pay today, and with us
          </div>
          <h1 style={{ marginTop: 8 }}>{a.data.entry.prospect}</h1>
          <p className="muted">
            Based on your {a.data.entry.processor || 'card processing'} statement for {a.data.entry.month}: {usd(a.data.entry.card_volume_cents)} in card sales over{' '}
            {a.data.entry.transactions.toLocaleString('en-US')} transactions (average {usd(a.data.analysis.average_ticket_cents)}).
          </p>
          <div className="grid4">
            <div className="panel stat">
              <div className="label">You pay today</div>
              <div className="value">{usd(a.data.analysis.today_total_cents)}</div>
              <div className="tiny muted">a month: card fees {usd(a.data.entry.total_fees_cents)} + POS {usd(a.data.entry.pos_fees_cents)}</div>
            </div>
            <div className="panel stat">
              <div className="label">Your effective rate</div>
              <div className="value">{pct(a.data.analysis.effective_rate_ppm)}</div>
              <div className="tiny muted">of every card dollar</div>
            </div>
            {a.data.analysis.markup_cents !== null && (
              <div className="panel stat">
                <div className="label">Processor markup</div>
                <div className="value">{usd(a.data.analysis.markup_cents)}</div>
                <div className="tiny muted">{pct(a.data.analysis.markup_rate_ppm)} above interchange</div>
              </div>
            )}
          </div>
          <h2>With AD Pay</h2>
          <table>
            <tbody>
              {a.data.analysis.quotes.map((q, i) => (
                <tr key={i}>
                  <td>
                    <strong>{describePlan(q.plan)}</strong>
                    {q.note && <div className="tiny muted">{q.note}</div>}
                  </td>
                  <td className="num">{usd(q.merchant_cost_cents)} / month</td>
                  <td className="num">{q.saving_cents > 0 ? <span className="money approved">save {usd(q.saving_cents * 12)} a year</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {best.saving_cents > 0 && (
            <p style={{ fontSize: 20, marginTop: 16 }}>
              You keep <span className="money approved">{usd(best.saving_cents)}</span> more every month.
            </p>
          )}
          <p className="tiny muted" style={{ marginTop: 24 }}>
            Figures from one month’s statement; your savings depend on your card mix. Includes the POS register, customer screen and support.
            {a.data.created_by_name ? ` Prepared by ${a.data.created_by_name}.` : ''}
          </p>
        </div>
      )}
    </Shell>
  );
}
