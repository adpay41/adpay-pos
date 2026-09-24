'use client';
/**
 * Staff for one merchant, as AD Pay support sees it (build plan P3): who works there, role, whether
 * they have a register PIN and app access, and the permission matrix. Support can add people, set
 * a PIN during an install, change roles and remove people. PINs are write-only here too.
 */
import { PERMISSIONS, PERMISSION_KEYS, ROLES, permissionsFor, pinProblem, type PermissionOverrides, type Role, type StaffMember } from '@adpay/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ErrorBox, When, useLoad } from './ui';

export function StaffPanel({ merchantId }: { merchantId: string }) {
  const base = `/admin/merchants/${merchantId}`;
  const data = useLoad(() => api<{ staff: StaffMember[]; overrides: PermissionOverrides }>(`${base}/staff`), [merchantId]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', role: 'cashier' as Role, phone: '', pin: '' });

  const done = (msg: string) => {
    setNotice(`${msg} Registers update within ~15 seconds.`);
    setTimeout(() => setNotice(null), 5000);
    data.reload();
  };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      done(msg);
    } catch (e) {
      setError(e);
    }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    if (f.pin && pinProblem(f.pin)) return setError(new Error(pinProblem(f.pin)!));
    await run(
      () => api(`${base}/staff`, { method: 'POST', body: { name: f.name.trim(), role: f.role, phone: f.phone.trim() || null, pin: f.pin || null } }),
      `${f.name.trim()} added.`,
    );
    setF({ name: '', role: 'cashier', phone: '', pin: '' });
  }

  function setPin(m: StaffMember) {
    const pin = window.prompt(`New register PIN for ${m.name} (4–6 digits)`) ?? '';
    if (!pin) return;
    const problem = pinProblem(pin);
    if (problem) return setError(new Error(problem));
    void run(() => api(`${base}/staff/${m.user_id}/pin`, { method: 'PUT', body: { pin } }), `PIN set for ${m.name}.`);
  }

  return (
    <>
      <ErrorBox error={data.error ?? error} />
      {notice && <div className="notice">{notice}</div>}
      <div className="panel">
        <h2>Staff</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Register PIN</th>
                <th>App access</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.data?.staff.map((m) => (
                <tr key={m.user_id} className={m.disabled ? 'inactive' : ''}>
                  <td>
                    <strong>{m.name}</strong>
                  </td>
                  <td>
                    <select
                      value={m.role}
                      onChange={(e) => void run(() => api(`${base}/staff/${m.user_id}`, { method: 'PATCH', body: { role: e.target.value } }), `${m.name} is now ${e.target.value}.`)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{m.has_pin ? <>set <When at={m.pin_set_at} /></> : <span className="muted">not set</span>}</td>
                  <td>{m.app_access ? m.phone : <span className="muted">register only</span>}</td>
                  <td>{m.disabled ? <span className="pill">removed</span> : <span className="pill ok">active</span>}</td>
                  <td className="actions-row">
                    <button onClick={() => setPin(m)}>{m.has_pin ? 'Reset PIN' : 'Set PIN'}</button>
                    <button
                      onClick={() =>
                        void run(
                          () => api(`${base}/staff/${m.user_id}`, { method: 'PATCH', body: { disabled: !m.disabled } }),
                          m.disabled ? `${m.name} restored.` : `${m.name} removed.`,
                        )
                      }
                    >
                      {m.disabled ? 'Restore' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="inline" onSubmit={add} style={{ marginTop: 12 }}>
          <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} />
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input placeholder="Mobile (optional)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <input placeholder="PIN (optional)" value={f.pin} inputMode="numeric" type="password" onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} style={{ width: 120 }} />
          <button className="primary" disabled={!f.name.trim()}>
            Add person
          </button>
        </form>
      </div>

      {data.data && (
        <div className="panel">
          <h2>Permissions</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Owners hold everything. At the register, a missing permission turns into a manager-PIN approval.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Manager</th>
                  <th>Cashier</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSION_KEYS.map((p) => (
                  <tr key={p}>
                    <td>{PERMISSIONS[p].label}</td>
                    {(['manager', 'cashier'] as const).map((role) => {
                      const o = data.data!.overrides;
                      const on = permissionsFor(role, o).includes(p);
                      return (
                        <td key={role}>
                          <input
                            type="checkbox"
                            checked={on}
                            aria-label={`${role}: ${PERMISSIONS[p].label}`}
                            onChange={(e) => {
                              const next = { ...(o[role] ?? {}) };
                              if (permissionsFor(role).includes(p) === e.target.checked) delete next[p];
                              else next[p] = e.target.checked;
                              void run(() => api(`${base}/permissions`, { method: 'PUT', body: { ...o, [role]: next } }), 'Permissions saved.');
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
