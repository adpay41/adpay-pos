'use client';
/**
 * Staged rollouts and the kill switch (Bible 3.2; P24b, ADR 0037): each feature flag's platform-wide
 * stage — canary stores, then 10% of stores, then all — over the per-store switches on the merchant
 * page. The kill switch turns a flag off everywhere, over every store switch; registers pick it up
 * within seconds. Every move needs a reason and is kept in the flag's history and the audit log.
 * Delivering a new register build (OTA) waits on the MDM decision and is not here.
 */
import { ROLLOUT_STAGE_LABELS, ROLLOUT_STAGES, type RolloutStage } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Flag {
  flag: string;
  label: string;
  where: string;
  default: boolean;
  stage: RolloutStage;
  canary: { merchant_id: string; name: string }[];
  on: number;
  stores: number;
  overridden: number;
  history: { stage: RolloutStage; reason: string; set_by_name: string | null; at: string }[];
}
interface Tree {
  orgs: { merchants: { merchant_id: string; name: string }[] }[];
}

export default function RolloutsPage() {
  const flags = useLoad(() => api<{ flags: Flag[] }>('/admin/rollouts'), []);
  const tree = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const merchants = useMemo(() => (tree.data?.orgs ?? []).flatMap((o) => o.merchants).sort((a, b) => a.name.localeCompare(b.name)), [tree.data]);
  return (
    <Shell>
      <h1>Rollouts</h1>
      <p className="muted">
        Stage a feature across stores: canary stores first, then 10%, then everyone. The kill switch turns it off everywhere at once. A store&apos;s own switch (merchant page → Plan &amp; setup)
        beats the stage, but never the kill switch.
      </p>
      <ErrorBox error={flags.error} />
      {flags.data?.flags.map((f) => <FlagCard key={`${f.flag}:${f.stage}:${f.history[0]?.at ?? ''}`} f={f} merchants={merchants} onSaved={flags.reload} />)}
    </Shell>
  );
}

function FlagCard({ f, merchants, onSaved }: { f: Flag; merchants: { merchant_id: string; name: string }[]; onSaved: () => void }) {
  const [stage, setStage] = useState<RolloutStage>(f.stage === 'killed' ? 'default' : f.stage);
  const [canary, setCanary] = useState<string[]>(f.canary.map((c) => c.merchant_id));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save(to: RolloutStage) {
    setError(null);
    setBusy(true);
    try {
      await api(`/admin/rollouts/${f.flag}`, { method: 'PUT', body: { stage: to, canary_merchant_ids: canary, reason } });
      setReason('');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const killed = f.stage === 'killed';
  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>
          {f.label} <span className="tiny muted mono">{f.flag}</span>
        </h2>
        <span className={`pill ${killed ? 'bad' : f.stage === 'default' ? '' : 'warn'}`}>{ROLLOUT_STAGE_LABELS[f.stage]}</span>
      </div>
      <p className="tiny muted">
        On for {f.on} of {f.stores} stores · code default {f.default ? 'on' : 'off'} · {f.where}
        {f.overridden ? ` · ${f.overridden} store${f.overridden === 1 ? '' : 's'} with their own switch` : ''}
        {f.canary.length ? ` · canary: ${f.canary.map((c) => c.name).join(', ')}` : ''}
      </p>
      <div className="form-grid">
        <label className="field">
          Stage
          <select value={stage} onChange={(e) => setStage(e.target.value as RolloutStage)}>
            {ROLLOUT_STAGES.filter((s) => s !== 'killed').map((s) => (
              <option key={s} value={s}>
                {ROLLOUT_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Canary stores
          <select multiple value={canary} onChange={(e) => setCanary([...e.target.selectedOptions].map((o) => o.value))} style={{ minHeight: 70 }}>
            {merchants.map((m) => (
              <option key={m.merchant_id} value={m.merchant_id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field span2">
          Reason (kept in the history)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. canary looked clean for 3 days" maxLength={300} />
        </label>
        <div className="span2" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy || reason.trim().length < 3 || (stage === 'canary' && !canary.length)} onClick={() => void save(stage)}>
            {killed ? 'Lift the kill switch: set stage' : 'Set stage'}
          </button>
          {!killed ? (
            <button className="primary" disabled={busy || reason.trim().length < 3} onClick={() => void save('killed')}>
              Kill switch: off everywhere
            </button>
          ) : null}
        </div>
      </div>
      <ErrorBox error={error} />
      {f.history.length ? (
        <div className="tiny muted" style={{ marginTop: 8 }}>
          {f.history.map((h) => (
            <div key={h.at}>
              {new Date(h.at).toLocaleString()} · {ROLLOUT_STAGE_LABELS[h.stage]} · {h.set_by_name ?? 'admin'}: {h.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
