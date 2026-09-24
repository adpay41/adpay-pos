'use client';
import type { SaleListRow, SalesSummary } from '@adpay/shared';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CashPanel } from '../../../components/cash-panel';
import { CatalogEditor } from '../../../components/catalog-editor';
import { ConfigPanel } from '../../../components/config-panel';
import { PricingPanel } from '../../../components/pricing-panel';
import { SalesTable, SummaryView } from '../../../components/sales';
import { StaffPanel } from '../../../components/staff-panel';
import { ErrorBox, Shell, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';

type Range = SalesSummary['range'];

interface Tree {
  orgs: { name: string; merchants: { merchant_id: string; name: string }[] }[];
}

export default function MerchantPage() {
  const { merchantId } = useParams<{ merchantId: string }>();
  const [range, setRange] = useState<Range>('today');
  const [tab, setTab] = useState<'sales' | 'cash' | 'catalog' | 'staff' | 'plan'>('sales');
  const tree = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const org = tree.data?.orgs.find((o) => o.merchants.some((m) => m.merchant_id === merchantId));
  const merchant = org?.merchants.find((m) => m.merchant_id === merchantId);
  const summary = useLoad(() => api<SalesSummary>(`/admin/merchants/${merchantId}/sales/summary?range=${range}`), [merchantId, range]);
  const sales = useLoad(() => api<{ sales: SaleListRow[] }>(`/admin/sales?merchant_id=${merchantId}&limit=50`), [merchantId]);

  return (
    <Shell>
      <h1>
        {merchant?.name ?? 'Merchant'}
        {org && <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}> · {org.name}</span>}
      </h1>
      <div className="tabs">
        <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>
          Sales
        </button>
        <button className={tab === 'cash' ? 'active' : ''} onClick={() => setTab('cash')}>
          Cash
        </button>
        <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
          Catalog
        </button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>
          Staff
        </button>
        <button className={tab === 'plan' ? 'active' : ''} onClick={() => setTab('plan')}>
          Plan & setup
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

      {tab === 'cash' && <CashPanel merchantId={merchantId} />}
      {tab === 'catalog' && <CatalogEditor merchantId={merchantId} merchantName={merchant?.name ?? 'Your store'} />}
      {tab === 'staff' && <StaffPanel merchantId={merchantId} />}
      {tab === 'plan' && (
        <>
          <PricingPanel merchantId={merchantId} />
          <ConfigPanel merchantId={merchantId} />
        </>
      )}
    </Shell>
  );
}
