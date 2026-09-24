'use client';
import type { SaleListRow } from '@adpay/shared';
import { SalesTable } from '../../components/sales';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

export default function SalesPage() {
  const { data, error } = useLoad(() => api<{ sales: SaleListRow[] }>('/admin/sales?limit=100'), []);
  return (
    <Shell>
      <h1>Latest tickets — all merchants</h1>
      <p className="muted">Click a ticket to replay it event by event.</p>
      <ErrorBox error={error} />
      <div className="panel">{data ? <SalesTable sales={data.sales} /> : <p className="muted">Loading…</p>}</div>
    </Shell>
  );
}
