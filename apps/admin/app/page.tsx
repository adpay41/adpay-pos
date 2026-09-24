'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Pct, Shell, StatusPill, When, useLoad } from '../components/ui';
import { api } from '../lib/api';

interface Tree {
  orgs: {
    org_id: string;
    name: string;
    merchants: {
      merchant_id: string;
      name: string;
      enabled_packs: string[];
      catalog_version: number;
      item_count: number;
      locations: {
        location_id: string;
        name: string;
        city: string | null;
        state: string | null;
        tax_rate_ppm: number;
        dual_price_rate_ppm: number;
        registers: { register_id: string; name: string; status: string; paired_at: string | null; last_seen_at: string | null }[];
      }[];
    }[];
  }[];
}

/** Percent text ("6.625") → ppm integer, parsed as a decimal string — no floats. */
function pctToPpm(input: string): number {
  const m = /^(\d{1,3})(?:\.(\d{0,4}))?$/.exec(input.trim());
  if (!m) throw new Error(`Not a percentage: ${input}`);
  return Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
}

export default function MerchantsPage() {
  const { data, error, reload } = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const [setup, setSetup] = useState<{ label: string; code: string; expires_at: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  async function issueCode(registerId: string, label: string) {
    setActionError(null);
    try {
      const r = await api<{ code: string; expires_at: string }>(`/admin/registers/${registerId}/setup-code`, { method: 'POST' });
      setSetup({ label, ...r });
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <Shell>
      <h1>Merchants</h1>
      <ErrorBox error={error ?? actionError} />

      {setup && (
        <div className="panel">
          <h2>Setup code — {setup.label}</h2>
          <div className="code-box">{setup.code}</div>
          <p className="muted">
            Enter this on the register (step 4 turns it into the setup QR). One use; expires <When at={setup.expires_at} />.
            Pairing with it revokes any device currently holding this register.
          </p>
          <button onClick={() => setSetup(null)}>Done</button>
        </div>
      )}

      <div className="panel tree">
        {!data ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul>
            {data.orgs.map((o) => (
              <li key={o.org_id}>
                <div className="node">
                  <strong>{o.name}</strong> <span className="pill">org</span>
                </div>
                <ul>
                  {o.merchants.map((m) => (
                    <li key={m.merchant_id}>
                      <div className="node">
                        <Link href={`/merchants/${m.merchant_id}`}>
                          <strong>{m.name}</strong>
                        </Link>
                        <span className="pill">merchant</span>
                        {m.enabled_packs.map((p) => (
                          <span key={p} className="pill">
                            {p}
                          </span>
                        ))}
                        <span className="muted">
                          {m.item_count} items · catalog v{m.catalog_version}
                        </span>
                      </div>
                      <ul>
                        {m.locations.map((l) => (
                          <li key={l.location_id}>
                            <div className="node">
                              <strong>{l.name}</strong>
                              <span className="muted">
                                {[l.city, l.state].filter(Boolean).join(', ')} · tax <Pct ppm={l.tax_rate_ppm} /> · card price +
                                <Pct ppm={l.dual_price_rate_ppm} />
                              </span>
                            </div>
                            <ul>
                              {l.registers.map((r) => (
                                <li key={r.register_id}>
                                  <div className="node">
                                    {r.name} <StatusPill status={r.status} />
                                    <span className="muted">
                                      last seen <When at={r.last_seen_at} />
                                    </span>
                                    <button onClick={() => issueCode(r.register_id, `${m.name} · ${l.name} · ${r.name}`)}>
                                      Setup code
                                    </button>
                                  </div>
                                </li>
                              ))}
                              <li>
                                <AddForm
                                  placeholder="New register name"
                                  onAdd={(name) =>
                                    act(() => api('/admin/registers', { method: 'POST', body: { location_id: l.location_id, name } }))
                                  }
                                />
                              </li>
                            </ul>
                          </li>
                        ))}
                        <li>
                          <NewLocationForm
                            onAdd={(body) => act(() => api('/admin/locations', { method: 'POST', body: { merchant_id: m.merchant_id, ...body } }))}
                          />
                        </li>
                      </ul>
                    </li>
                  ))}
                  <li>
                    <AddForm
                      placeholder="New merchant name"
                      onAdd={(name) => act(() => api('/admin/merchants', { method: 'POST', body: { org_id: o.org_id, name } }))}
                    />
                  </li>
                </ul>
              </li>
            ))}
            <li>
              <AddForm placeholder="New org name" onAdd={(name) => act(() => api('/admin/orgs', { method: 'POST', body: { name } }))} />
            </li>
          </ul>
        )}
      </div>
      <p className="muted">Every create and every setup code is written to the audit log.</p>
    </Shell>
  );
}

function AddForm({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <form
      className="inline"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        await onAdd(name.trim());
        setName('');
      }}
    >
      <input placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={!name.trim()}>Add</button>
    </form>
  );
}

function NewLocationForm({ onAdd }: { onAdd: (body: Record<string, unknown>) => Promise<void> }) {
  const [f, setF] = useState({ name: '', city: '', state: 'NJ', tax: '6.625', dual: '4' });
  const [err, setErr] = useState<unknown>(null);
  return (
    <form
      className="inline"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        setErr(null);
        try {
          await onAdd({
            name: f.name,
            city: f.city || null,
            state: f.state || null,
            tax_rate_ppm: pctToPpm(f.tax),
            dual_price_rate_ppm: pctToPpm(f.dual),
          });
          setF({ ...f, name: '', city: '' });
        } catch (x) {
          setErr(x);
        }
      }}
    >
      <input placeholder="New location name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input placeholder="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} style={{ width: 120 }} />
      <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
        <option>NJ</option>
        <option>NY</option>
      </select>
      <label className="field">
        tax %
        <input value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })} style={{ width: 80 }} />
      </label>
      <label className="field">
        card +%
        <input value={f.dual} onChange={(e) => setF({ ...f, dual: e.target.value })} style={{ width: 70 }} />
      </label>
      <button disabled={!f.name.trim()}>Add location</button>
      <ErrorBox error={err} />
    </form>
  );
}
