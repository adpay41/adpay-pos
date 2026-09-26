'use client';
/**
 * Hardware inventory & RMA (Bible 3.2; P24a): every unit by serial, where it is, its warranty, and
 * the swap workflow: the faulty unit goes to RMA, a unit from stock goes in its place, one step.
 * Every move is kept in the unit's history.
 */
import { HARDWARE_KINDS, HardwareInput } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Unit {
  unit_id: string;
  kind: string;
  model: string;
  serial: string;
  warranty_until: string | null;
  note: string | null;
  status: 'in_stock' | 'installed' | 'rma' | 'retired';
  merchant_name: string | null;
  location_name: string | null;
  register_name: string | null;
}
interface Tree {
  orgs: { merchants: { name: string; locations: { name: string; registers: { register_id: string; name: string }[] }[] }[] }[];
}

export default function HardwarePage() {
  const units = useLoad(() => api<{ units: Unit[] }>('/admin/hardware'), []);
  const tree = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState({ kind: 'printer', model: '', serial: '', warranty_until: '' });
  const [open, setOpen] = useState<string | null>(null);
  const registers = useMemo(
    () => (tree.data?.orgs ?? []).flatMap((o) => o.merchants.flatMap((m) => m.locations.flatMap((l) => l.registers.map((r) => ({ id: r.register_id, label: `${m.name} · ${l.name} · ${r.name}` }))))),
    [tree.data],
  );
  const parsed = HardwareInput.safeParse({ kind: f.kind, model: f.model.trim(), serial: f.serial.trim(), warranty_until: f.warranty_until || null });
  const today = new Date().toISOString().slice(0, 10);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      units.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Shell>
      <h1>Hardware</h1>
      <ErrorBox error={error ?? units.error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Serial</th>
              <th>Where</th>
              <th>Warranty</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {units.data?.units.map((u) => (
              <tr key={u.unit_id}>
                <td>
                  {u.kind.replace('_', ' ')} · {u.model}
                </td>
                <td className="mono">{u.serial}</td>
                <td>{u.merchant_name ? `${u.merchant_name} · ${u.location_name ?? ''}${u.register_name ? ` · ${u.register_name}` : ''}` : <span className="muted">—</span>}</td>
                <td className={u.warranty_until && u.warranty_until < today ? 'muted' : ''}>{u.warranty_until ?? '—'}</td>
                <td>
                  <span className={`pill ${u.status === 'rma' ? 'warn' : u.status === 'installed' ? 'ok' : ''}`}>{u.status.replace('_', ' ')}</span>
                </td>
                <td>
                  {open === u.unit_id ? (
                    <UnitActions u={u} registers={registers} stock={(units.data?.units ?? []).filter((x) => x.status === 'in_stock' && x.kind === u.kind && x.unit_id !== u.unit_id)} run={run} />
                  ) : (
                    <button onClick={() => setOpen(u.unit_id)}>…</button>
                  )}
                </td>
              </tr>
            ))}
            {units.data?.units.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No hardware yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Add a unit</h2>
        <div className="form-grid">
          <label className="field">
            Kind
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {HARDWARE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Model
            <input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Sunmi T2s" />
          </label>
          <label className="field">
            Serial
            <input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} />
          </label>
          <label className="field">
            Warranty until
            <input type="date" value={f.warranty_until} onChange={(e) => setF({ ...f, warranty_until: e.target.value })} />
          </label>
          <div className="span2">
            <button className="primary" disabled={!parsed.success} onClick={() => void run(() => api('/admin/hardware', { method: 'POST', body: parsed.data })).then(() => setF({ ...f, serial: '' }))}>
              Add to stock
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function UnitActions({ u, registers, stock, run }: { u: Unit; registers: { id: string; label: string }[]; stock: Unit[]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [register, setRegister] = useState(registers[0]?.id ?? '');
  const [replacement, setReplacement] = useState(stock[0]?.unit_id ?? '');
  const [reason, setReason] = useState('');
  const history = useLoad(() => api<{ events: { kind: string; at: string; actor: string | null }[] }>(`/admin/hardware/${u.unit_id}/history`), [u.unit_id]);
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 280 }}>
      {u.status === 'in_stock' ? (
        <>
          <select value={register} onChange={(e) => setRegister(e.target.value)}>
            {registers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button onClick={() => void run(() => api(`/admin/hardware/${u.unit_id}/install`, { method: 'POST', body: { register_id: register } }))}>Install</button>
        </>
      ) : null}
      {u.status === 'installed' ? (
        <>
          <select value={replacement} onChange={(e) => setReplacement(e.target.value)}>
            {stock.length ? null : <option value="">No {u.kind} in stock</option>}
            {stock.map((s) => (
              <option key={s.unit_id} value={s.unit_id}>
                {s.model} · {s.serial}
              </option>
            ))}
          </select>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong with it" />
          <button disabled={!replacement || reason.trim().length < 3} onClick={() => void run(() => api(`/admin/hardware/${u.unit_id}/swap`, { method: 'POST', body: { new_unit_id: replacement, reason } }))}>
            Swap (old one to RMA)
          </button>
        </>
      ) : null}
      {u.status === 'rma' ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => void run(() => api(`/admin/hardware/${u.unit_id}/rma-close`, { method: 'POST', body: { outcome: 'repaired' } }))}>Back from repair</button>
          <button onClick={() => void run(() => api(`/admin/hardware/${u.unit_id}/rma-close`, { method: 'POST', body: { outcome: 'retired' } }))}>Retire</button>
        </div>
      ) : null}
      <div className="tiny muted">{history.data?.events.map((e) => `${e.kind.replace('_', ' ')} ${new Date(e.at).toLocaleDateString()}`).join(' → ')}</div>
    </div>
  );
}
