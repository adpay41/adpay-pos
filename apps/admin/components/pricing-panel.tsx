'use client';
/**
 * Pricing plans per merchant with history (build plan P12a, Bible 3.3 L51). A change is a new plan
 * with an effective date; nothing is overwritten. A dual-pricing plan can also set every location's
 * card-price markup the moment it starts.
 */
import {
  PLAN_KIND_LABELS,
  PricingPlanInput,
  cents,
  formatUsd,
  parseUsdToCents,
  percentToPpm,
  ppmToPercent,
  type PricingPlan,
  type PricingPlanRow,
} from '@adpay/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, useLoad } from './ui';

const usd = (c: number) => formatUsd(cents(c));

export function describePlan(p: PricingPlan): string {
  const fees = `${usd(p.monthly_cents)}/mo${p.per_register_cents ? ` + ${usd(p.per_register_cents)}/extra register` : ''}`;
  if (p.kind === 'dual_pricing') return `Card price +${ppmToPercent(p.dual_price_rate_ppm)}% · ${fees}`;
  if (p.kind === 'ic_plus') return `Interchange + ${ppmToPercent(p.markup_ppm)}% + ${usd(p.per_txn_cents)} · ${fees}`;
  return `${ppmToPercent(p.rate_ppm)}% + ${usd(p.per_txn_cents)} · ${fees}`;
}

export function PricingPanel({ merchantId }: { merchantId: string }) {
  const plans = useLoad(() => api<{ plans: PricingPlanRow[] }>(`/admin/merchants/${merchantId}/pricing`), [merchantId]);
  const [f, setF] = useState({ kind: 'dual_pricing' as PricingPlan['kind'], pct: '4', perTxn: '0.10', monthly: '49.00', perRegister: '0.00', from: new Date().toLocaleDateString('en-CA') /* local YYYY-MM-DD, not UTC */, note: '', apply: true });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parsed = useMemo(() => {
    try {
      const base = { monthly_cents: parseUsdToCents(f.monthly), per_register_cents: parseUsdToCents(f.perRegister), effective_from: f.from, note: f.note.trim() || null };
      const pct = percentToPpm(f.pct);
      const plan =
        f.kind === 'dual_pricing'
          ? { kind: f.kind, dual_price_rate_ppm: pct, ...base }
          : f.kind === 'ic_plus'
            ? { kind: f.kind, markup_ppm: pct, per_txn_cents: parseUsdToCents(f.perTxn), ...base }
            : { kind: f.kind, rate_ppm: pct, per_txn_cents: parseUsdToCents(f.perTxn), ...base };
      return { ok: true as const, plan: PricingPlanInput.parse(plan) };
    } catch (e) {
      return { ok: false as const, message: (e as { issues?: { message: string }[] }).issues?.[0]?.message ?? (e as Error).message };
    }
  }, [f]);

  async function add() {
    if (!parsed.ok) return setError(new Error(parsed.message));
    setError(null);
    try {
      await api(`/admin/merchants/${merchantId}/pricing`, { method: 'POST', body: { plan: parsed.plan, apply_to_locations: f.kind === 'dual_pricing' && f.apply } });
      setNotice('Plan added.');
      plans.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Pricing plan</h2>
          <Link href={`/merchants/${merchantId}/install-kit`}>Print install kit →</Link>
        </div>
        <ErrorBox error={plans.error} />
        {plans.data && plans.data.plans.length === 0 && <p className="muted">No plan recorded yet.</p>}
        {plans.data && plans.data.plans.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Plan</th>
                  <th>Terms</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {plans.data.plans.map((r) => (
                  <tr key={r.plan_id} className={r.current ? '' : 'inactive'}>
                    <td>
                      {r.plan.effective_from} {r.current && <span className="pill ok">current</span>}
                    </td>
                    <td>{PLAN_KIND_LABELS[r.plan.kind]}</td>
                    <td>
                      {describePlan(r.plan)}
                      {r.plan.note && <div className="tiny muted">{r.plan.note}</div>}
                    </td>
                    <td className="tiny muted">
                      {new Date(r.created_at).toLocaleDateString()} {r.created_by_name ? `by ${r.created_by_name}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel">
        <h2>Change the plan</h2>
        <div className="form-grid">
          <label className="field">
            Plan
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PricingPlan['kind'] })}>
              {Object.entries(PLAN_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {f.kind === 'dual_pricing' ? 'Card price = cash + (%)' : f.kind === 'ic_plus' ? 'Interchange + (%)' : 'Rate (%)'}
            <input value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} inputMode="decimal" />
          </label>
          {f.kind !== 'dual_pricing' && (
            <label className="field">
              + per transaction ($)
              <input value={f.perTxn} onChange={(e) => setF({ ...f, perTxn: e.target.value })} inputMode="decimal" />
            </label>
          )}
          <label className="field">
            Subscription per month ($)
            <input value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} inputMode="decimal" />
          </label>
          <label className="field">
            + per extra register ($)
            <input value={f.perRegister} onChange={(e) => setF({ ...f, perRegister: e.target.value })} inputMode="decimal" />
          </label>
          <label className="field">
            Starts
            <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </label>
          <label className="field span2">
            Note <span className="muted">(why: promo, renegotiated…)</span>
            <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />
          </label>
          {f.kind === 'dual_pricing' && (
            <label className="check span2">
              <input type="checkbox" checked={f.apply} onChange={(e) => setF({ ...f, apply: e.target.checked })} /> Also set every location’s card price markup now
              (moves card prices on the registers within ~15 s)
            </label>
          )}
        </div>
        <ErrorBox error={error ?? (parsed.ok ? null : new Error(parsed.message))} />
        {notice && <div className="notice">{notice}</div>}
        <div className="actions-row">
          <button className="primary" disabled={!parsed.ok} onClick={() => void add()}>
            Add plan
          </button>
        </div>
      </div>
    </>
  );
}
