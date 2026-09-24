'use client';
/**
 * Fleet: every register, its health from the last heartbeat, sync queue, config version and open
 * alerts (P4). Updates live as heartbeats arrive.
 */
import { HARDWARE_SLOTS, registerHealth, type FleetRow } from '@adpay/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Ago, HealthDot, HwBadge, useNow } from '../../components/ops-ui';
import { useRealtime } from '../../components/realtime';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

export default function FleetPage() {
  const fleet = useLoad(() => api<{ registers: FleetRow[] }>('/admin/fleet'), []);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const now = useNow();

  // A heartbeat bumps the row's "last seen" live; a full reload picks up everything else.
  useRealtime((m) => {
    if (m.type === 'register') setSeen((s) => ({ ...s, [m.register_id]: m.last_heartbeat_at }));
    if (m.type === 'alert') fleet.reload();
  });

  const rows = useMemo(() => {
    const all = (fleet.data?.registers ?? []).map((r) => ({ ...r, last_heartbeat_at: seen[r.register_id] ?? r.last_heartbeat_at }));
    if (filter === 'all') return all;
    return all.filter((r) => r.status === 'active' && (r.open_alerts > 0 || registerHealth(r.last_heartbeat_at, now) !== 'online' || (r.queued ?? 0) > 0));
  }, [fleet.data, seen, filter, now]);

  return (
    <Shell>
      <h1>Fleet</h1>
      <div className="toolbar">
        <div className="tabs" style={{ margin: 0 }}>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All registers
          </button>
          <button className={filter === 'problems' ? 'active' : ''} onClick={() => setFilter('problems')}>
            Needs attention
          </button>
        </div>
        <span className="muted">Heartbeat every 30 s · quiet after 90 s · offline alert after 5 min</span>
      </div>
      <ErrorBox error={fleet.error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Register</th>
              <th>Store</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Version</th>
              <th className="num">Queued</th>
              <th>Config</th>
              <th>Hardware</th>
              <th className="num">Alerts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.register_id} className="link">
                <td>
                  <Link href={`/devices/${r.register_id}`}>
                    <strong>{r.register_name}</strong>
                  </Link>
                  {r.status !== 'active' && <span className="pill"> {r.status}</span>}
                </td>
                <td>
                  {r.merchant_name} <span className="muted">· {r.location_name}</span>
                </td>
                <td>{r.status === 'active' ? <HealthDot lastHeartbeatAt={r.last_heartbeat_at} now={now} /> : <span className="muted">—</span>}</td>
                <td>
                  <Ago at={r.last_heartbeat_at} now={now} />
                </td>
                <td className="mono">
                  {r.app_version ?? '—'} {r.platform && <span className="muted">{r.platform}</span>}
                </td>
                <td className="num">{r.queued ?? '—'}</td>
                <td>
                  {r.device_catalog_version === null ? (
                    <span className="muted">—</span>
                  ) : r.device_catalog_version === r.server_catalog_version ? (
                    <span className="muted">v{r.device_catalog_version} current</span>
                  ) : (
                    <span className="pill warn">
                      v{r.device_catalog_version} → v{r.server_catalog_version}
                    </span>
                  )}
                </td>
                <td className="hw">
                  {r.hardware
                    ? HARDWARE_SLOTS.filter((s) => r.hardware![s].state !== 'not_present').map((s) => <HwBadge key={s} name={s} slot={r.hardware![s]} />)
                    : <span className="muted">—</span>}
                </td>
                <td className="num">{r.open_alerts > 0 ? <span className="pill bad">{r.open_alerts}</span> : <span className="muted">0</span>}</td>
              </tr>
            ))}
            {fleet.data && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  {filter === 'problems' ? 'Nothing needs attention.' : 'No registers yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
