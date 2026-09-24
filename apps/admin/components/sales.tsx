'use client';
import type { SaleListRow, SalesSummary } from '@adpay/shared';
import { useRouter } from 'next/navigation';
import { Money, StatusPill, When } from './ui';

export function SummaryView({ s }: { s: SalesSummary }) {
  const max = Math.max(1, ...s.by_hour.map((h) => h.amount_cents));
  const hours = Array.from({ length: 24 }, (_, h) => s.by_hour.find((x) => x.hour === h) ?? { hour: h, amount_cents: 0, count: 0 });
  const shown = hours.filter((h) => h.hour >= 5 && h.hour <= 23);
  const avg = s.sale_count ? Math.round(s.gross_cents / s.sale_count) : 0;
  return (
    <>
      <div className="grid">
        <div className="panel stat">
          <div className="label">Net sales (tender)</div>
          <div className="value">
            <Money cents={s.gross_cents} />
          </div>
          <div className="muted">
            {s.from === s.to ? s.from : `${s.from} → ${s.to}`}
          </div>
        </div>
        <div className="panel stat">
          <div className="label">Tickets</div>
          <div className="value">{s.sale_count.toLocaleString('en-US')}</div>
          <div className="muted">
            avg <Money cents={avg} />
          </div>
        </div>
        <div className="panel stat">
          <div className="label">Sales tax collected</div>
          <div className="value">
            <Money cents={s.tax_cents} />
          </div>
        </div>
        <div className="panel stat">
          <div className="label">Voids · refunds</div>
          <div className="value">{s.voids}</div>
          <div className="muted">
            refunds <Money cents={s.refunds_cents} />
          </div>
        </div>
      </div>
      <div className="grid">
        <div className="panel">
          <h2>By hour</h2>
          <div className="bars">
            {shown.map((h) => (
              <div
                key={h.hour}
                className="bar"
                style={{ height: `${Math.round((h.amount_cents * 100) / max)}%` }}
                title={`${h.hour}:00 — ${h.count} tickets`}
              />
            ))}
          </div>
          <div className="bars-x">
            {shown.map((h) => (
              <span key={h.hour}>{h.hour % 3 === 0 ? `${((h.hour + 11) % 12) + 1}${h.hour < 12 ? 'a' : 'p'}` : ''}</span>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>By tender</h2>
          <table>
            <tbody>
              {s.by_tender.map((t) => (
                <tr key={t.tender_type}>
                  <td>{t.tender_type === 'card' ? 'Card' : 'Cash'}</td>
                  <td className="num muted">{t.count} tickets</td>
                  <td className="num">
                    <Money cents={t.amount_cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>By register</h2>
          <table>
            <tbody>
              {s.by_register.map((r) => (
                <tr key={r.register_id}>
                  <td>{r.register_name}</td>
                  <td className="num muted">{r.count}</td>
                  <td className="num">
                    <Money cents={r.amount_cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function SalesTable({ sales }: { sales: SaleListRow[] }) {
  const router = useRouter();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Where</th>
            <th>Status</th>
            <th>Tender</th>
            <th className="num">Lines</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.sale_id} className="link" onClick={() => router.push(`/sales/${s.sale_id}`)}>
              <td>
                <When at={s.occurred_at} />
              </td>
              <td>
                {s.location_name} · {s.register_name}
              </td>
              <td>
                <StatusPill status={s.status} />
              </td>
              <td>{s.price_mode ?? '—'}</td>
              <td className="num">{s.item_count}</td>
              <td className="num">{s.status === 'completed' ? <Money cents={s.total_cents} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
