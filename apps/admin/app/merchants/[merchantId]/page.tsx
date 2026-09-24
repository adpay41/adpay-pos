'use client';
import type { CatalogSnapshot, SaleListRow, SalesSummary } from '@adpay/shared';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SalesTable, SummaryView } from '../../../components/sales';
import { ErrorBox, Money, Pct, Shell, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';

type Range = SalesSummary['range'];

export default function MerchantPage() {
  const { merchantId } = useParams<{ merchantId: string }>();
  const [range, setRange] = useState<Range>('today');
  const [tab, setTab] = useState<'sales' | 'catalog'>('sales');
  const summary = useLoad(() => api<SalesSummary>(`/admin/merchants/${merchantId}/sales/summary?range=${range}`), [merchantId, range]);
  const catalog = useLoad(() => api<CatalogSnapshot>(`/admin/merchants/${merchantId}/catalog`), [merchantId]);
  const sales = useLoad(() => api<{ sales: SaleListRow[] }>(`/admin/sales?merchant_id=${merchantId}&limit=50`), [merchantId]);

  return (
    <Shell>
      <h1>Merchant</h1>
      <div className="tabs">
        <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>
          Sales
        </button>
        <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
          Catalog
        </button>
      </div>

      {tab === 'sales' && (
        <>
          <div className="tabs">
            {(['today', 'week', 'month'] as const).map((r) => (
              <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
                {r === 'today' ? 'Today' : r === 'week' ? 'Last 7 days' : 'Month to date'}
              </button>
            ))}
          </div>
          <ErrorBox error={summary.error} />
          {summary.data && <SummaryView s={summary.data} />}
          <div className="panel">
            <h2>Latest tickets</h2>
            <ErrorBox error={sales.error} />
            {sales.data && <SalesTable sales={sales.data.sales} />}
          </div>
        </>
      )}

      {tab === 'catalog' && (
        <div className="panel">
          <ErrorBox error={catalog.error} />
          {catalog.data && (
            <>
              <p className="muted">
                Catalog v{catalog.data.catalog_version} as posted at the first location: tax <Pct ppm={catalog.data.tax_rate_ppm} />, card
                price = cash + <Pct ppm={catalog.data.dual_price_rate_ppm} /> unless the item sets its own. Editing arrives with the
                catalog editor.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Item</th>
                      <th>UPC</th>
                      <th className="num">Cash</th>
                      <th className="num">Card</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.data.items.map((i) => (
                      <tr key={i.item_id}>
                        <td className="muted">{catalog.data!.categories.find((c) => c.category_id === i.category_id)?.name}</td>
                        <td>{i.name}</td>
                        <td className="mono">{i.upc}</td>
                        <td className="num">
                          <Money cents={i.cash_price_cents} />
                        </td>
                        <td className="num">
                          <Money cents={i.card_price_cents} />
                          {i.card_price_override && <span className="muted"> *</span>}
                        </td>
                        <td>
                          {!i.taxable && <span className="pill">non-taxable</span>} {i.min_age && <span className="pill warn">{i.min_age}+</span>}{' '}
                          {i.sell_unit === 'pack' && <span className="pill">pack of {i.pack_qty}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">* explicit card price (e.g. lottery at face value)</p>
            </>
          )}
        </div>
      )}
    </Shell>
  );
}
