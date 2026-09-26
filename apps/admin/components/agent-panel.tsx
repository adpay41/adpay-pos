'use client';
/**
 * The store's agent or referral partner (P25b, ADR 0040): who brought it, from when. A change is a
 * new dated row from the first of a month; months already on a statement don't move.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, useLoad } from './ui';

interface History {
  agent_id: string | null;
  agent_name: string | null;
  effective_from: string;
  note: string | null;
}

export function AgentPanel({ merchantId }: { merchantId: string }) {
  const history = useLoad(() => api<{ history: History[] }>(`/admin/merchants/${merchantId}/agent`), [merchantId]);
  const agents = useLoad(() => api<{ agents: { agent_id: string; name: string; active: boolean }[] }>('/admin/agents'), []);
  const [agent, setAgent] = useState('');
  const [from, setFrom] = useState(`${new Date().toISOString().slice(0, 7)}-01`);
  const [error, setError] = useState<unknown>(null);
  const current = history.data?.history[0];

  async function save() {
    setError(null);
    try {
      await api(`/admin/merchants/${merchantId}/agent`, { method: 'POST', body: { agent_id: agent || null, effective_from: from, note: null } });
      history.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="panel">
      <h2>Agent / referral</h2>
      <p className="muted">{current?.agent_name ? `${current.agent_name} since ${current.effective_from}` : 'No agent.'}</p>
      <div className="form-grid">
        <label className="field">
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">None</option>
            {agents.data?.agents
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          From (first of a month)
          <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="YYYY-MM-01" />
        </label>
        <div className="span2">
          <ErrorBox error={error} />
          <button onClick={() => void save()}>Set</button>
        </div>
      </div>
      {history.data && history.data.history.length > 1 ? (
        <div className="tiny muted">
          {history.data.history.map((h) => (
            <div key={`${h.effective_from}:${h.agent_id}`}>
              {h.effective_from} · {h.agent_name ?? 'none'}
              {h.note ? ` · ${h.note}` : ''}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
