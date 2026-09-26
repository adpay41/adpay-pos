'use client';
/**
 * Support tickets (Bible 3.2; P24a): every store's tickets with the first-response SLA counting down,
 * linked to the store, register and sale. A canned fix writes its steps to the store and presses the
 * remote-action button on the ticket's register; internal notes stay with AD Pay.
 */
import { CANNED_FIXES, REMOTE_ACTIONS, slaMinutesLeft, TICKET_STATUSES, type CannedFixKey, type TicketStatus } from '@adpay/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useNow } from '../../components/ops-ui';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Row {
  ticket_id: string;
  merchant_id: string;
  merchant_name: string;
  register_name: string | null;
  subject: string;
  category: string;
  priority: 'normal' | 'urgent';
  status: TicketStatus;
  source: string;
  created_at: string;
  sla_due_at: string;
  first_response_at: string | null;
  notes: number;
}
interface Detail extends Row {
  body: string;
  register_id: string | null;
  sale_id: string | null;
  location_name: string | null;
  notes_list?: never;
  notes: never;
}

function Sla({ t, now }: { t: Pick<Row, 'created_at' | 'first_response_at' | 'priority'>; now: number }) {
  const left = slaMinutesLeft(t, new Date(now));
  if (left === null) return <span className="muted">answered</span>;
  const h = Math.floor(Math.abs(left) / 60);
  const m = Math.abs(left) % 60;
  return <span className={`pill ${left < 0 ? 'bad' : left < 60 ? 'warn' : ''}`}>{left < 0 ? `overdue ${h}h ${m}m` : `${h}h ${m}m left`}</span>;
}

export default function TicketsPage() {
  const [filter, setFilter] = useState<'active' | TicketStatus>('active');
  const list = useLoad(() => api<{ tickets: Row[] }>(`/admin/tickets?status=${filter}`), [filter]);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow();
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setOpenId(id);
  }, []);
  return (
    <Shell>
      <h1>Tickets</h1>
      <div className="tabs">
        {(['active', ...TICKET_STATUSES] as const).map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s === 'active' ? 'Open & pending' : s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>SLA</th>
              <th>Subject</th>
              <th>Store</th>
              <th>Status</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.tickets.map((t) => (
              <tr key={t.ticket_id} className={openId === t.ticket_id ? 'selected' : ''} onClick={() => setOpenId(t.ticket_id)} style={{ cursor: 'pointer' }}>
                <td>{t.status === 'solved' ? <span className="muted">—</span> : <Sla t={t} now={now} />}</td>
                <td>
                  {t.priority === 'urgent' ? <span className="pill bad">urgent</span> : null} {t.subject}
                  <div className="tiny muted">
                    {t.category} · from {t.source === 'merchant' ? 'the store' : 'AD Pay'} · {t.notes} notes
                  </div>
                </td>
                <td>
                  <Link href={`/merchants/${t.merchant_id}`}>{t.merchant_name}</Link>
                  {t.register_name ? <div className="tiny muted">{t.register_name}</div> : null}
                </td>
                <td>{t.status}</td>
                <td className="tiny">{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {list.data?.tickets.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No tickets.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {openId ? <TicketPanel id={openId} onChanged={list.reload} /> : null}
    </Shell>
  );
}

function TicketPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useLoad(
    () =>
      api<Omit<Detail, 'notes'> & { notes: { note_id: string; author_kind: string; author: string | null; body: string; canned_fix: string | null; action_id: string | null; status_to: string | null; visible_to_merchant: boolean; created_at: string }[] }>(
        `/admin/tickets/${id}`,
      ),
    [id],
  );
  const [body, setBody] = useState('');
  const [fix, setFix] = useState<CannedFixKey | ''>('');
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function send() {
    setError(null);
    try {
      await api(`/admin/tickets/${id}/notes`, { method: 'POST', body: { body, canned_fix: fix || null, status: status || null, internal } });
      setBody('');
      setFix('');
      setStatus('');
      t.reload();
      onChanged();
    } catch (e) {
      setError(e);
    }
  }
  if (!t.data) return <ErrorBox error={t.error} />;
  const d = t.data;
  const chosen = fix ? CANNED_FIXES[fix] : null;
  return (
    <div className="panel">
      <h2>{d.subject}</h2>
      <p className="muted">
        {d.merchant_name}
        {d.location_name ? ` · ${d.location_name}` : ''}
        {d.register_id ? (
          <>
            {' · '}
            <Link href={`/devices/${d.register_id}`}>{d.register_name}</Link>
          </>
        ) : null}
        {d.sale_id ? (
          <>
            {' · '}
            <Link href={`/sales/${d.sale_id}`}>sale</Link>
          </>
        ) : null}
      </p>
      {d.body ? <p style={{ whiteSpace: 'pre-wrap' }}>{d.body}</p> : null}
      {d.notes.map((n) => (
        <div key={n.note_id} className={`note ${n.visible_to_merchant ? '' : 'internal'}`} style={{ borderLeft: '3px solid var(--line)', paddingLeft: 10, margin: '8px 0' }}>
          <div className="tiny muted">
            {n.author ?? n.author_kind} · {new Date(n.created_at).toLocaleString()}
            {n.visible_to_merchant ? '' : ' · internal'}
            {n.canned_fix ? ` · fix: ${CANNED_FIXES[n.canned_fix as CannedFixKey]?.title ?? n.canned_fix}` : ''}
            {n.action_id ? ' · remote action sent' : ''}
            {n.status_to ? ` · → ${n.status_to}` : ''}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
        </div>
      ))}
      <div className="form-grid">
        <label className="field span2">
          Canned fix
          <select value={fix} onChange={(e) => setFix(e.target.value as CannedFixKey | '')}>
            <option value="">—</option>
            {(Object.keys(CANNED_FIXES) as CannedFixKey[]).map((k) => (
              <option key={k} value={k}>
                {CANNED_FIXES[k].title}
                {CANNED_FIXES[k].action ? ` (sends ${REMOTE_ACTIONS[CANNED_FIXES[k].action!].label})` : ''}
              </option>
            ))}
          </select>
        </label>
        {chosen ? <p className="span2 tiny muted">{chosen.steps}</p> : null}
        <label className="field span2">
          Note
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | '')}>
            <option value="">(unchanged)</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal (the store doesn't see it)
        </label>
        <div className="span2">
          <ErrorBox error={error} />
          <button className="primary" onClick={() => void send()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
