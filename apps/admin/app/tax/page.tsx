'use client';
/**
 * Tax tables across every store (build plan P16b, Bible 3.4 "tax tables by jurisdiction with
 * effective dates"): the rate in force today per location, rate changes scheduled ahead, classes,
 * per-unit charges and age overrides, grouped by state, to spot a store that's out of line. Each
 * location's rules are edited on its merchant's Catalog tab (Tax & compliance). Values need an
 * accountant's sign-off.
 */
import { ppmToPercent, cents, formatUsd } from '@adpay/shared';
import Link from 'next/link';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Row {
  merchant_id: string;
  merchant_name: string;
  location_id: string;
  location_name: string;
  state: string | null;
  standard_rate_ppm: number;
  upcoming: { tax_class: string; rate_ppm: number; effective_from: string }[];
  classes: string[];
  charges: { kind: string; label: string; amount_cents: number | null; rate_ppm: number | null; categories: number }[];
  age_overrides: Record<string, number>;
}

export default function TaxTablesPage() {
  const t = useLoad(() => api<{ locations: Row[] }>('/admin/tax-tables'), []);
  const byState = new Map<string, Row[]>();
  for (const r of t.data?.locations ?? []) byState.set(r.state ?? '—', [...(byState.get(r.state ?? '—') ?? []), r]);
  return (
    <Shell>
      <h1>Tax tables</h1>
      <p className="muted">Rates in force today for every store, and changes already scheduled. Edit a store’s rules on its merchant page → Catalog → Tax & compliance.</p>
      <ErrorBox error={t.error} />
      {[...byState.entries()].map(([state, rows]) => {
        const rates = new Set(rows.map((r) => r.standard_rate_ppm));
        return (
          <div key={state} className="panel table-wrap">
            <h2>
              {state} {rates.size > 1 && <span className="pill warn">{rates.size} different standard rates</span>}
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th className="num">Sales tax today</th>
                  <th>Scheduled</th>
                  <th>Classes</th>
                  <th>Charges</th>
                  <th>Age overrides</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.location_id}>
                    <td>
                      <Link href={`/merchants/${r.merchant_id}`}>{r.merchant_name}</Link>
                      <div className="tiny muted">{r.location_name}</div>
                    </td>
                    <td className="num">{ppmToPercent(r.standard_rate_ppm)}%</td>
                    <td className="tiny">{r.upcoming.map((u) => `${u.tax_class} ${ppmToPercent(u.rate_ppm)}% from ${u.effective_from}`).join('; ') || '—'}</td>
                    <td className="tiny">{r.classes.join(', ') || 'standard'}</td>
                    <td className="tiny">
                      {r.charges.map((c) => `${c.label} ${c.amount_cents !== null ? formatUsd(cents(c.amount_cents)) : `${ppmToPercent(c.rate_ppm ?? 0)}%`}${c.kind !== 'bag' && c.categories === 0 ? ' (applies to nothing)' : ''}`).join('; ') || '—'}
                    </td>
                    <td className="tiny">{Object.entries(r.age_overrides).map(([k, v]) => `${k} ${v}+`).join(', ') || 'state defaults'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </Shell>
  );
}
