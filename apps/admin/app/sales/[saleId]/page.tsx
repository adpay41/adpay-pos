'use client';
import { lineTotal, type FoldedSale } from '@adpay/shared';
import { useParams } from 'next/navigation';
import { ErrorBox, Money, Shell, StatusPill, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';

interface Timeline {
  sale_id: string;
  merchant_name: string;
  location_name: string;
  register_name: string;
  register_id: string;
  events: { event_id: string; type: string; device_seq: number; occurred_at: string; received_at: string; business_date: string; trace_id: string; payload: unknown }[];
  folded: FoldedSale;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export default function SaleTimelinePage() {
  const { saleId } = useParams<{ saleId: string }>();
  const { data, error } = useLoad(() => api<Timeline>(`/admin/sales/${saleId}`), [saleId]);
  const f = data?.folded;
  const totals = f ? (f.price_mode === 'card' ? f.card : f.cash) : null;

  return (
    <Shell>
      <h1>Ticket replay</h1>
      <ErrorBox error={error} />
      {data && f && totals && (
        <>
          <div className="panel">
            <div className="node" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>{data.merchant_name}</strong>
              <span>
                {data.location_name} · {data.register_name}
              </span>
              <StatusPill status={f.status} />
              {f.price_mode && <span className="pill">{f.price_mode} price</span>}
              {f.mismatch && <span className="pill bad">device total ≠ server fold</span>}
              <span className="mono muted">{data.sale_id}</span>
            </div>
          </div>

          <div className="grid">
            <div className="panel">
              <h2>Folded from events</h2>
              <table>
                <tbody>
                  {f.lines.map((l) => (
                    <tr key={l.line_id}>
                      <td>
                        {l.qty > 1 ? `${l.qty} × ` : ''}
                        {l.name}
                        {l.min_age && (
                          <span className={`pill ${l.age_verified ? 'ok' : 'warn'}`} style={{ marginLeft: 6 }}>
                            {l.min_age}+ {l.age_verified ? 'verified' : 'unverified'}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <Money cents={lineTotal(l, f.price_mode === 'card' ? 'card' : 'cash')} />
                        {(l.charges ?? []).map((c) => (
                          <div key={c.rule_id} className="tiny muted">
                            incl. {c.label}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">Subtotal</td>
                    <td className="num">
                      <Money cents={totals.subtotal_cents} />
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Tax</td>
                    <td className="num">
                      <Money cents={totals.tax_cents} />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    <td className="num">
                      <strong>
                        <Money cents={totals.total_cents} approved={f.status === 'completed'} />
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h2>Dual price at time of sale</h2>
              <table>
                <tbody>
                  <tr>
                    <td>Cash price</td>
                    <td className="num">
                      <Money cents={f.cash.total_cents} />
                    </td>
                  </tr>
                  <tr>
                    <td>Card price</td>
                    <td className="num">
                      <Money cents={f.card.total_cents} />
                    </td>
                  </tr>
                  {f.tenders.map((t) => (
                    <tr key={t.tender_id}>
                      <td>
                        {t.tender_type} tender {t.approved ? <span className="pill ok">approved</span> : <span className="pill bad">declined</span>}
                      </td>
                      <td className="num">
                        <Money cents={t.amount_cents} approved={t.approved} />
                        {t.change_cents > 0 && (
                          <div className="muted">
                            change <Money cents={t.change_cents} />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {f.refunded_cents > 0 && (
                    <tr>
                      <td>Refunded</td>
                      <td className="num">
                        <Money cents={f.refunded_cents} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h2>Event log ({data.events.length} immutable events)</h2>
            <ul className="timeline">
              {data.events.map((e) => (
                <li key={e.event_id}>
                  <div>
                    <div>{time(e.occurred_at)}</div>
                    <div className="muted mono">seq {e.device_seq}</div>
                  </div>
                  <div>
                    <strong>{e.type}</strong>
                    <div className="muted mono" title={e.event_id}>
                      synced {time(e.received_at)}
                    </div>
                  </div>
                  <pre className="mono">{JSON.stringify(e.payload, null, 2)}</pre>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Shell>
  );
}
