'use client';
/**
 * Alert console (Bible 3.2 / L48): every open alert across the fleet, most severe first, live.
 * Rules run every minute; "Check now" runs them immediately.
 */
import type { Alert } from '@adpay/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Ago, SeverityPill, useNow } from '../../components/ops-ui';
import { useRealtime } from '../../components/realtime';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

export default function AlertsPage() {
  const [open, setOpen] = useState(true);
  const alerts = useLoad(() => api<{ alerts: Alert[] }>(`/admin/alerts?open=${open ? 1 : 0}`), [open]);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const now = useNow();
  useRealtime((m) => {
    if (m.type === 'alert') alerts.reload();
  });

  async function checkNow() {
    setError(null);
    try {
      const r = await api<{ opened: number; resolved: number; still_open: number }>('/admin/alerts/evaluate', { method: 'POST', body: {} });
      setNote(`Checked: ${r.opened} new, ${r.resolved} resolved, ${r.still_open} still open.`);
      alerts.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function ack(a: Alert) {
    try {
      await api(`/admin/alerts/${a.alert_id}/ack`, { method: 'POST', body: {} });
      alerts.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Shell>
      <h1>Alerts</h1>
      <div className="toolbar">
        <div className="tabs" style={{ margin: 0 }}>
          <button className={open ? 'active' : ''} onClick={() => setOpen(true)}>
            Open
          </button>
          <button className={!open ? 'active' : ''} onClick={() => setOpen(false)}>
            All (incl. resolved)
          </button>
        </div>
        <button onClick={() => void checkNow()}>Check now</button>
        {note && <span className="muted">{note}</span>}
      </div>
      <ErrorBox error={alerts.error ?? error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>What</th>
              <th>Store</th>
              <th>Register</th>
              <th>Opened</th>
              <th>Last seen</th>
              <th>Acknowledged</th>
            </tr>
          </thead>
          <tbody>
            {alerts.data?.alerts.map((a) => (
              <tr key={a.alert_id} className={a.resolved_at ? 'inactive' : ''}>
                <td>
                  <SeverityPill a={a} />
                </td>
                <td>{a.title}</td>
                <td>
                  {a.merchant_id ? <Link href={`/merchants/${a.merchant_id}`}>{a.merchant_name}</Link> : '—'}
                  {a.location_name && <span className="muted"> · {a.location_name}</span>}
                </td>
                <td>{a.register_id ? <Link href={`/devices/${a.register_id}`}>{a.register_name}</Link> : <span className="muted">—</span>}</td>
                <td>
                  <Ago at={a.opened_at} now={now} />
                </td>
                <td>
                  <Ago at={a.last_seen_at} now={now} />
                </td>
                <td>
                  {a.acknowledged_at ? (
                    <span className="muted">{a.acknowledged_by_name ?? 'yes'}</span>
                  ) : a.resolved_at ? (
                    <span className="muted">—</span>
                  ) : (
                    <button onClick={() => void ack(a)}>Acknowledge</button>
                  )}
                </td>
              </tr>
            ))}
            {alerts.data && alerts.data.alerts.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No {open ? 'open ' : ''}alerts.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
