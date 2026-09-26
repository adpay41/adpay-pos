'use client';
/**
 * Partners (Bible 3.4; P25a, ADR 0039): API keys that let a partner read one store's data, and the
 * webhooks that push its sales to them, signed. A key or a signing secret is shown once, when it is
 * made; after that only its first characters. Partner docs: docs/partner-api.md.
 */
import { API_SCOPE_KEYS, API_SCOPES, WEBHOOK_EVENT_KEYS, WEBHOOK_EVENTS, type ApiScope, type WebhookEvent } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Key {
  key_id: string;
  merchant_name: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface Endpoint {
  endpoint_id: string;
  merchant_name: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  disabled_at: string | null;
  delivered: number;
  pending: number;
  failed: number;
}
interface Delivery {
  delivery_id: string;
  event_type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}
interface Tree {
  orgs: { merchants: { merchant_id: string; name: string }[] }[];
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

export default function PartnersPage() {
  const keys = useLoad(() => api<{ keys: Key[] }>('/admin/api-keys'), []);
  const hooks = useLoad(() => api<{ endpoints: Endpoint[] }>('/admin/webhooks'), []);
  const tree = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const merchants = useMemo(() => (tree.data?.orgs ?? []).flatMap((o) => o.merchants).sort((a, b) => a.name.localeCompare(b.name)), [tree.data]);
  const [error, setError] = useState<unknown>(null);
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const [openHook, setOpenHook] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setError(null);
    try {
      const r = await fn();
      after?.(r);
      keys.reload();
      hooks.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Shell>
      <h1>Partners</h1>
      <ErrorBox error={error ?? keys.error ?? hooks.error} />
      {shown ? (
        <div className="panel" style={{ borderColor: 'var(--black)' }}>
          <strong>{shown.label}: copy it now, it won&apos;t be shown again.</strong>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {shown.value}
          </pre>
          <button onClick={() => setShown(null)}>I&apos;ve copied it</button>
        </div>
      ) : null}

      <div className="panel">
        <h2>API keys</h2>
        <NewKey merchants={merchants} onCreate={(body) => void run(() => api<{ key: string }>('/admin/api-keys', { method: 'POST', body }), (r) => setShown({ label: 'API key', value: r.key }))} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Store</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data?.keys.map((k) => (
                <tr key={k.key_id} className={k.revoked_at ? 'muted' : ''}>
                  <td>
                    {k.name} <div className="tiny mono">adp_{k.prefix}_…</div>
                  </td>
                  <td>{k.merchant_name}</td>
                  <td className="tiny">{k.scopes.join(', ')}</td>
                  <td className="tiny">{when(k.last_used_at)}</td>
                  <td>{k.revoked_at ? <span className="tiny">revoked {when(k.revoked_at)}</span> : <button onClick={() => void run(() => api(`/admin/api-keys/${k.key_id}/revoke`, { method: 'POST' }))}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Webhooks</h2>
        <NewHook merchants={merchants} onCreate={(body) => void run(() => api<{ secret: string }>('/admin/webhooks', { method: 'POST', body }), (r) => setShown({ label: 'Signing secret', value: r.secret }))} />
        {hooks.data?.endpoints.map((h) => (
          <div key={h.endpoint_id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="mono">{h.url}</span>
              <span className="tiny muted">
                {h.merchant_name} · {h.events.join(', ')} · {h.delivered} delivered · {h.pending} pending · {h.failed} failed
              </span>
              {h.disabled_at ? <span className="pill">off</span> : null}
              <span style={{ flex: 1 }} />
              <button onClick={() => setOpenHook(openHook === h.endpoint_id ? null : h.endpoint_id)}>{openHook === h.endpoint_id ? 'Hide' : 'Deliveries'}</button>
              {!h.disabled_at ? (
                <>
                  <button onClick={() => void run(() => api<{ secret: string }>(`/admin/webhooks/${h.endpoint_id}/rotate-secret`, { method: 'POST' }), (r) => setShown({ label: 'New signing secret', value: r.secret }))}>Rotate secret</button>
                  <button onClick={() => void run(() => api(`/admin/webhooks/${h.endpoint_id}/disable`, { method: 'POST' }))}>Turn off</button>
                </>
              ) : null}
            </div>
            {openHook === h.endpoint_id ? <Deliveries id={h.endpoint_id} run={run} /> : null}
          </div>
        ))}
      </div>
    </Shell>
  );
}

function NewKey({ merchants, onCreate }: { merchants: { merchant_id: string; name: string }[]; onCreate: (body: unknown) => void }) {
  const [merchant, setMerchant] = useState('');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['sales:read']);
  return (
    <div className="form-grid">
      <label className="field">
        Store
        <select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
          <option value="">—</option>
          {merchants.map((m) => (
            <option key={m.merchant_id} value={m.merchant_id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Partner / purpose
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bookkeeper sync" maxLength={80} />
      </label>
      <div className="span2">
        {API_SCOPE_KEYS.map((s) => (
          <label key={s} className="check" style={{ display: 'block' }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> <span className="mono">{s}</span>{' '}
            <span className="tiny muted">{API_SCOPES[s]}</span>
          </label>
        ))}
      </div>
      <div className="span2">
        <button className="primary" disabled={!merchant || name.trim().length < 2 || !scopes.length} onClick={() => onCreate({ merchant_id: merchant, name: name.trim(), scopes })}>
          Create key
        </button>
      </div>
    </div>
  );
}

function NewHook({ merchants, onCreate }: { merchants: { merchant_id: string; name: string }[]; onCreate: (body: unknown) => void }) {
  const [merchant, setMerchant] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['sale.completed']);
  return (
    <div className="form-grid">
      <label className="field">
        Store
        <select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
          <option value="">—</option>
          {merchants.map((m) => (
            <option key={m.merchant_id} value={m.merchant_id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        URL (https)
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://partner.example.com/adpay" />
      </label>
      <label className="field span2">
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />
      </label>
      <div className="span2">
        {WEBHOOK_EVENT_KEYS.map((ev) => (
          <label key={ev} className="check" style={{ display: 'inline-block', marginRight: 12 }}>
            <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} /> <span className="mono">{ev}</span>{' '}
            <span className="tiny muted">{WEBHOOK_EVENTS[ev]}</span>
          </label>
        ))}
      </div>
      <div className="span2">
        <button className="primary" disabled={!merchant || !url || !events.length} onClick={() => onCreate({ merchant_id: merchant, url: url.trim(), description, events })}>
          Add webhook
        </button>
      </div>
    </div>
  );
}

function Deliveries({ id, run }: { id: string; run: <T>(fn: () => Promise<T>) => Promise<void> }) {
  const list = useLoad(() => api<{ deliveries: Delivery[] }>(`/admin/webhooks/${id}/deliveries`), [id]);
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {list.data?.deliveries.map((d) => (
            <tr key={d.delivery_id}>
              <td className="tiny">{when(d.created_at)}</td>
              <td className="mono tiny">{d.event_type}</td>
              <td>
                <span className={`pill ${d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}`}>{d.status}</span>
              </td>
              <td className="tiny">
                {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                {d.last_error ? ` · ${d.last_error}` : ''}
                {d.status === 'pending' && d.next_attempt_at ? ` · next ${when(d.next_attempt_at)}` : ''}
              </td>
              <td>
                {d.status !== 'delivered' ? (
                  <button onClick={() => void run(() => api(`/admin/webhook-deliveries/${d.delivery_id}/redeliver`, { method: 'POST' })).then(list.reload)}>Send again</button>
                ) : null}
              </td>
            </tr>
          ))}
          {list.data?.deliveries.length === 0 ? (
            <tr>
              <td className="muted">Nothing sent yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
