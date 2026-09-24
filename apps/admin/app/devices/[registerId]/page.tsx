'use client';
/**
 * Device page (spec step 3, Bible 3.2 / L44–L45): live heartbeat, version, network, hardware,
 * queue, config diff, the last 200 log lines, the event timeline, alerts, and remote-action buttons
 * (each one audited). "From admin: restart the app, push a price change, reprint a receipt, and
 * read the last 200 log lines of a register — without touching the device."
 */
import { HARDWARE_SLOTS, REMOTE_ACTIONS, type DevicePage, type RemoteActionKind } from '@adpay/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Ago, HealthDot, HwBadge, SeverityPill, useNow } from '../../../components/ops-ui';
import { useRealtime } from '../../../components/realtime';
import { ErrorBox, Shell, When, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';

export default function DevicePageView() {
  const { registerId } = useParams<{ registerId: string }>();
  const page = useLoad(() => api<DevicePage>(`/admin/registers/${registerId}`), [registerId]);
  const [error, setError] = useState<unknown>(null);
  const [reprintSale, setReprintSale] = useState('');
  const now = useNow(5_000);

  // Heartbeats, alerts and action results show up without a reload.
  useRealtime((m) => {
    if ((m.type === 'register' && m.register_id === registerId) || (m.type === 'alert' && m.alert.register_id === registerId)) page.reload();
  });

  async function act(kind: RemoteActionKind, params: Record<string, string> = {}) {
    setError(null);
    try {
      await api(`/admin/registers/${registerId}/actions`, { method: 'POST', body: { kind, params } });
      page.reload();
      // Results come back within a heartbeat (or instantly over the socket); refresh once more.
      setTimeout(() => page.reload(), 3_000);
    } catch (e) {
      setError(e);
    }
  }

  const d = page.data;
  const hb = d?.heartbeat ?? null;
  const pending = d?.actions.some((a) => a.status === 'queued' || a.status === 'delivered');

  return (
    <Shell>
      <ErrorBox error={page.error ?? error} />
      {d && (
        <>
          <h1>
            {d.register_name}{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>
              · <Link href={`/merchants/${d.merchant_id}`}>{d.merchant_name}</Link> · {d.location_name}
            </span>
          </h1>

          <div className="grid4">
            <div className="panel kpi">
              <div className="label">Status</div>
              <div className="value">{d.status === 'active' ? <HealthDot lastHeartbeatAt={d.last_heartbeat_at} now={now} /> : d.status}</div>
              <div className="muted">
                last heartbeat <Ago at={d.last_heartbeat_at} now={now} /> · realtime {d.ws_connected ? 'connected' : 'off (polling)'}
              </div>
            </div>
            <div className="panel kpi">
              <div className="label">Sync queue</div>
              <div className="value">{hb?.sync.queued ?? '—'}</div>
              <div className="muted">
                last sync <Ago at={hb?.sync.last_sync_at ?? null} now={now} />
                {hb?.sync.rejected ? ` · ${hb.sync.rejected} rejected` : ''}
              </div>
            </div>
            <div className="panel kpi">
              <div className="label">Config</div>
              <div className="value">{d.device_catalog_version === null ? '—' : `v${d.device_catalog_version}`}</div>
              <div className="muted">
                {d.device_catalog_version === null
                  ? 'no heartbeat yet'
                  : d.device_catalog_version === d.server_catalog_version
                    ? 'matches the server'
                    : `server is at v${d.server_catalog_version} — push config`}
              </div>
            </div>
            <div className="panel kpi">
              <div className="label">At the register</div>
              <div className="value" style={{ fontSize: 18 }}>
                {d.signed_in_name ?? <span className="muted">nobody signed in</span>}
              </div>
              <div className="muted">{hb?.open_sale_id ? `open ticket ${hb.open_sale_id.slice(0, 4).toUpperCase()}` : 'no open ticket'}</div>
            </div>
          </div>

          <div className="panel">
            <h2>Remote actions</h2>
            <div className="actions-row" style={{ flexWrap: 'wrap' }}>
              {(Object.keys(REMOTE_ACTIONS) as RemoteActionKind[])
                .filter((k) => k !== 'reprint')
                .map((k) => (
                  <button key={k} disabled={d.status !== 'active' || REMOTE_ACTIONS[k].needs !== null} title={REMOTE_ACTIONS[k].needs ?? undefined} onClick={() => void act(k)}>
                    {REMOTE_ACTIONS[k].label}
                  </button>
                ))}
            </div>
            <form
              className="inline"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                void act('reprint', { sale_id: reprintSale.trim() });
              }}
            >
              <select value={reprintSale} onChange={(e) => setReprintSale(e.target.value)}>
                <option value="">Reprint a ticket from this register…</option>
                {[...new Set(d.events.filter((e) => e.sale_id).map((e) => e.sale_id!))].slice(0, 15).map((id) => (
                  <option key={id} value={id}>
                    Ticket {id.slice(0, 4).toUpperCase()}
                  </option>
                ))}
              </select>
              <button disabled={!reprintSale || d.status !== 'active'}>Reprint</button>
            </form>
            <p className="muted" style={{ marginBottom: 0 }}>
              Greyed-out actions need the Android device module (build plan P-HW). Every request is in the audit log.
              {pending ? ' Waiting for the register to pick up an action…' : ''}
            </p>
            {d.actions.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Requested</th>
                      <th>Action</th>
                      <th>By</th>
                      <th>Status</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.actions.map((a) => (
                      <tr key={a.action_id}>
                        <td>
                          <When at={a.requested_at} />
                        </td>
                        <td>{REMOTE_ACTIONS[a.kind].label}</td>
                        <td className="muted">{a.requested_by_name ?? '—'}</td>
                        <td>
                          <span className={`pill ${a.status === 'succeeded' ? 'ok' : a.status === 'failed' ? 'bad' : a.status === 'unsupported' || a.status === 'expired' ? '' : 'warn'}`}>{a.status}</span>
                        </td>
                        <td>{a.result?.message ?? <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Device</h2>
            {hb ? (
              <div className="kv">
                <span>App</span>
                <span className="mono">
                  {hb.app_version} ({hb.platform}
                  {hb.build ? `, ${hb.build}` : ''}) · up {Math.floor(hb.uptime_s / 60)} min
                </span>
                <span>Network</span>
                <span>
                  {hb.network.online ? 'server reachable' : 'server unreachable'}
                  {hb.network.type ? ` · ${hb.network.type}` : ''}
                </span>
                <span>Power</span>
                <span>{hb.power.on_battery === null ? 'unknown (needs device module)' : hb.power.on_battery ? `on battery ${hb.power.battery_pct ?? '?'}%` : 'mains'}</span>
                <span>Storage free</span>
                <span>{hb.storage_free_mb === null ? 'unknown' : `${hb.storage_free_mb} MB`}</span>
                <span>Last sync error</span>
                <span>{hb.sync.last_error ?? <span className="muted">none</span>}</span>
                <span>Hardware</span>
                <span className="hw">
                  {HARDWARE_SLOTS.map((s) => (
                    <HwBadge key={s} name={s} slot={hb.hardware[s]} />
                  ))}
                </span>
              </div>
            ) : (
              <p className="muted">No heartbeat yet. It starts when the register opens the sale screen.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Log tail {d.logs && <span className="muted">(uploaded <When at={d.logs.uploaded_at} />, last {d.logs.lines.length} lines)</span>}</h2>
              <button onClick={() => void act('upload_logs')} disabled={d.status !== 'active'}>
                Fetch logs now
              </button>
            </div>
            {d.logs ? (
              <pre className="logtail">
                {d.logs.lines.map((l) => `${l.at.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} ${l.msg}${l.ctx ? ` ${JSON.stringify(l.ctx)}` : ''}`).join('\n')}
              </pre>
            ) : (
              <p className="muted">No logs uploaded yet. “Fetch logs now” asks the register for its last lines.</p>
            )}
          </div>

          <div className="grid2">
            <div className="panel">
              <h2>Alerts</h2>
              {d.alerts.length === 0 ? (
                <p className="muted">None.</p>
              ) : (
                <table>
                  <tbody>
                    {d.alerts.map((a) => (
                      <tr key={a.alert_id} className={a.resolved_at ? 'inactive' : ''}>
                        <td>
                          <SeverityPill a={a} />
                        </td>
                        <td>{a.title}</td>
                        <td className="muted">
                          <Ago at={a.opened_at} now={now} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="panel">
              <h2>Recent events</h2>
              <table>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.event_id}>
                      <td className="muted">
                        <Ago at={e.occurred_at} now={now} />
                      </td>
                      <td className="mono">{e.type}</td>
                      <td>{e.sale_id ? <Link href={`/sales/${e.sale_id}`}>ticket {e.sale_id.slice(0, 4).toUpperCase()}</Link> : <span className="muted">—</span>}</td>
                      <td className="muted">{e.actor_name ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
