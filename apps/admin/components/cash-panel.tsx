'use client';
/**
 * Cash drawer sessions for one merchant (P6): float, sales, drops, paid-outs, blind count and
 * over/short by cashier and day. Short is amber, never red near an amount.
 */
import { CASH_MOVEMENT_KINDS, type CashReport } from '@adpay/shared';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, Money, When, useLoad } from './ui';

function OverShort({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="muted">open</span>;
  if (cents === 0) return <span>even</span>;
  return (
    <span className={cents < 0 ? 'short' : ''}>
      {cents < 0 ? 'short ' : 'over '}
      <Money cents={Math.abs(cents)} />
    </span>
  );
}

export function CashPanel({ merchantId }: { merchantId: string }) {
  const [range, setRange] = useState<CashReport['range']>('week');
  const data = useLoad(() => api<CashReport>(`/admin/merchants/${merchantId}/cash?range=${range}`), [merchantId, range]);
  const d = data.data;
  return (
    <>
      <div className="tabs">
        {(['today', 'week', 'month'] as const).map((r) => (
          <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
            {r === 'today' ? 'Today' : r === 'week' ? 'Last 7 days' : 'Month to date'}
          </button>
        ))}
      </div>
      <ErrorBox error={data.error} />
      {d && (
        <>
          <div className="grid">
            <div className="panel stat">
              <div className="label">Over / short</div>
              <div className="value">
                <OverShort cents={d.totals.over_short_cents} />
              </div>
            </div>
            <div className="panel stat">
              <div className="label">Drops · paid out · paid in</div>
              <div className="value" style={{ fontSize: 18 }}>
                <Money cents={d.totals.drops_cents} /> · <Money cents={d.totals.paid_out_cents} /> · <Money cents={d.totals.paid_in_cents} />
              </div>
            </div>
            <div className="panel stat">
              <div className="label">No-sale drawer opens</div>
              <div className="value">{d.totals.no_sale_opens}</div>
            </div>
          </div>
          <div className="grid2">
            <div className="panel">
              <h2>By cashier</h2>
              <table>
                <tbody>
                  {d.by_cashier.map((c) => (
                    <tr key={c.user_id ?? 'none'}>
                      <td>{c.name ?? <span className="muted">not signed in</span>}</td>
                      <td className="num muted">{c.sessions} counts</td>
                      <td className="num">
                        <OverShort cents={c.over_short_cents} />
                      </td>
                    </tr>
                  ))}
                  {d.by_cashier.length === 0 && (
                    <tr>
                      <td className="muted">No closed drawers yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h2>By day</h2>
              <table>
                <tbody>
                  {d.by_day.map((x) => (
                    <tr key={x.date}>
                      <td>{x.date}</td>
                      <td className="num muted">{x.sessions} counts</td>
                      <td className="num">
                        <OverShort cents={x.over_short_cents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel table-wrap">
            <h2>Drawer sessions</h2>
            <table>
              <thead>
                <tr>
                  <th>Register</th>
                  <th>Opened</th>
                  <th className="num">Float</th>
                  <th className="num">Cash sales</th>
                  <th>Movements</th>
                  <th className="num">Expected</th>
                  <th className="num">Counted</th>
                  <th className="num">Over / short</th>
                </tr>
              </thead>
              <tbody>
                {d.sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td>
                      {s.register_name} <span className="muted">· {s.location_name}</span>
                    </td>
                    <td>
                      <When at={s.opened_at} /> <span className="muted">{s.opened_by_name ?? ''}</span>
                    </td>
                    <td className="num">
                      <Money cents={s.float_cents} />
                    </td>
                    <td className="num">
                      <Money cents={s.cash_sales_cents} /> <span className="muted">({s.cash_sale_count})</span>
                    </td>
                    <td>
                      {s.movements.map((m) => (
                        <div key={m.movement_id} className="tiny">
                          {CASH_MOVEMENT_KINDS[m.kind].label} <Money cents={m.amount_cents} /> <span className="muted">— {m.reason}</span>
                        </div>
                      ))}
                      {s.no_sale_opens > 0 && <div className="tiny muted">{s.no_sale_opens} no-sale opens</div>}
                    </td>
                    <td className="num">
                      <Money cents={s.expected_cents} />
                    </td>
                    <td className="num">{s.counted_cents === null ? <span className="muted">—</span> : <Money cents={s.counted_cents} />}</td>
                    <td className="num">
                      <OverShort cents={s.over_short_cents} />
                      {s.closed_by_name && <div className="tiny muted">{s.closed_by_name}</div>}
                    </td>
                  </tr>
                ))}
                {d.sessions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      No drawer sessions in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
