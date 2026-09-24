'use client';
/**
 * Onboarding (build plan P12a, Bible 3.1 L42/L43, ADR 0020): the pipeline of stores being set up,
 * and the wizard that creates one in a single step. Business → owner → location (with a draft
 * state tax template) → pricing plan → registers and install date → review. KYB waits for the
 * processor account (⛔) and is recorded as "not started".
 *
 * Percentages and dollars are typed as text and parsed to integer ppm / cents; no float math.
 */
import {
  OnboardingInput,
  PACKS,
  PACK_IDS,
  PLAN_KIND_LABELS,
  STATE_TEMPLATES,
  parseUsdToCents,
  percentToPpm,
  type OnboardingResult,
  type OnboardingRow,
  type PackId,
  type PricingPlan,
} from '@adpay/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Tree {
  orgs: { org_id: string; name: string }[];
}

const STATUS_LABEL: Record<OnboardingRow['status'], string> = { setting_up: 'Setting up', ready_to_install: 'Ready to install', live: 'Live' };
const today = () => new Date().toLocaleDateString('en-CA') /* local YYYY-MM-DD, not UTC */;

export default function OnboardingPage() {
  const list = useLoad(() => api<{ merchants: OnboardingRow[] }>('/admin/onboarding'), []);
  const [wizard, setWizard] = useState(false);
  const [done, setDone] = useState<OnboardingResult | null>(null);

  return (
    <Shell>
      <div className="panel-head">
        <h1>Onboarding</h1>
        {!wizard && (
          <button
            className="primary"
            onClick={() => {
              setDone(null);
              setWizard(true);
            }}
          >
            + New merchant
          </button>
        )}
      </div>
      {done && (
        <div className="notice">
          Merchant created with {done.register_ids.length} register{done.register_ids.length === 1 ? '' : 's'}. Next:{' '}
          <Link href={`/merchants/${done.merchant_id}/install-kit`}>print the install kit</Link> ·{' '}
          <Link href={`/merchants/${done.merchant_id}`}>open the merchant</Link>
        </div>
      )}
      {wizard && (
        <Wizard
          onCancel={() => setWizard(false)}
          onDone={(r) => {
            setWizard(false);
            setDone(r);
            list.reload();
          }}
        />
      )}
      <ErrorBox error={list.error} />
      {list.data && <Pipeline rows={list.data.merchants} onChanged={list.reload} />}
    </Shell>
  );
}

function Pipeline({ rows, onChanged }: { rows: OnboardingRow[]; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const patch = async (id: string, body: object) => {
    setError(null);
    try {
      await api(`/admin/onboarding/${id}`, { method: 'PATCH', body });
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="panel table-wrap">
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Merchant</th>
            <th>Status</th>
            <th>KYB</th>
            <th>Install date</th>
            <th className="num">Registers paired</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.merchant_id}>
              <td>
                <Link href={`/merchants/${r.merchant_id}`}>{r.merchant_name}</Link>
                <div className="tiny muted">{r.org_name}</div>
                {r.hardware_note && <div className="tiny muted">{r.hardware_note}</div>}
              </td>
              <td>
                <select value={r.status} onChange={(e) => void patch(r.merchant_id, { status: e.target.value })}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <span className="pill warn" title="Runs through the processor once the AD Pay LLC Finix account exists">
                  {r.kyb_status.replace('_', ' ')}
                </span>
              </td>
              <td>
                <input type="date" value={r.install_date ?? ''} onChange={(e) => void patch(r.merchant_id, { install_date: e.target.value || null })} />
              </td>
              <td className="num">
                {r.registers_paired} / {r.registers}
              </td>
              <td>{r.registers_paired < r.registers && <Link href={`/merchants/${r.merchant_id}/install-kit`}>Install kit</Link>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Wizard({ onCancel, onDone }: { onCancel: () => void; onDone: (r: OnboardingResult) => void }) {
  const tree = useLoad(() => api<Tree>('/admin/tenancy'), []);
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    orgMode: 'new' as 'new' | 'existing',
    orgId: '',
    orgName: '',
    name: '',
    legal: '',
    packs: ['cstore'] as PackId[],
    ownerName: '',
    ownerPhone: '',
    locName: 'Main',
    address: '',
    city: '',
    state: 'NJ',
    postal: '',
    tax: '6.625',
    template: 'NJ' as '' | 'NJ' | 'NY' | 'NYC',
    planKind: 'dual_pricing' as PricingPlan['kind'],
    dual: '4',
    markup: '0.3',
    rate: '2.9',
    perTxn: '0.10',
    monthly: '49.00',
    perRegister: '0.00',
    registers: '1',
    installDate: '',
    hardware: '',
  });
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const body = useMemo(() => {
    try {
      const pricingBase = { monthly_cents: parseUsdToCents(f.monthly), per_register_cents: parseUsdToCents(f.perRegister), effective_from: today(), note: null };
      const pricing =
        f.planKind === 'dual_pricing'
          ? { kind: 'dual_pricing' as const, dual_price_rate_ppm: percentToPpm(f.dual), ...pricingBase }
          : f.planKind === 'ic_plus'
            ? { kind: 'ic_plus' as const, markup_ppm: percentToPpm(f.markup), per_txn_cents: parseUsdToCents(f.perTxn), ...pricingBase }
            : { kind: 'flat' as const, rate_ppm: percentToPpm(f.rate), per_txn_cents: parseUsdToCents(f.perTxn), ...pricingBase };
      return {
        ok: true as const,
        value: OnboardingInput.parse({
          org: f.orgMode === 'existing' ? { org_id: f.orgId } : { name: f.orgName.trim() || f.name.trim() },
          merchant: { name: f.name, legal_name: f.legal.trim() || null, enabled_packs: f.packs },
          owner: { name: f.ownerName, phone: f.ownerPhone },
          location: {
            name: f.locName,
            address_line1: f.address.trim() || null,
            city: f.city.trim() || null,
            state: f.state,
            postal_code: f.postal.trim() || null,
            tax_rate_ppm: percentToPpm(f.tax),
            compliance_template: f.template || null,
          },
          registers: Number(f.registers),
          pricing,
          install_date: f.installDate || null,
          hardware_note: f.hardware.trim() || null,
        }),
      };
    } catch (e) {
      const issue = (e as { issues?: { message: string; path: (string | number)[] }[] }).issues?.[0];
      return { ok: false as const, message: issue ? `${issue.path.join('.')}: ${issue.message}` : (e as Error).message };
    }
  }, [f]);

  const steps = ['Business', 'Owner', 'Location', 'Pricing', 'Install', 'Review'];

  async function submit() {
    if (!body.ok) return setError(new Error(body.message));
    setBusy(true);
    setError(null);
    try {
      onDone(await api<OnboardingResult>('/admin/onboarding', { method: 'POST', body: body.value }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const tpl = f.template ? STATE_TEMPLATES[f.template] : null;

  return (
    <div className="panel">
      <div className="tabs">
        {steps.map((s, i) => (
          <button key={s} className={step === i ? 'active' : ''} onClick={() => setStep(i)}>
            {i + 1}. {s}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="form-grid">
          <fieldset className="span2">
            <legend>Organization (the legal owner of one or more stores)</legend>
            <label className="check">
              <input type="radio" checked={f.orgMode === 'new'} onChange={() => set({ orgMode: 'new' })} /> New
            </label>{' '}
            <label className="check">
              <input type="radio" checked={f.orgMode === 'existing'} onChange={() => set({ orgMode: 'existing' })} /> Existing
            </label>
            {f.orgMode === 'new' ? (
              <input placeholder="Organization name (defaults to the store name)" value={f.orgName} onChange={(e) => set({ orgName: e.target.value })} />
            ) : (
              <select value={f.orgId} onChange={(e) => set({ orgId: e.target.value })}>
                <option value="">Choose…</option>
                {tree.data?.orgs.map((o) => (
                  <option key={o.org_id} value={o.org_id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
          <label className="field">
            Store name
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Journal Square Deli" />
          </label>
          <label className="field">
            Legal name <span className="muted">(optional)</span>
            <input value={f.legal} onChange={(e) => set({ legal: e.target.value })} placeholder="JSQ Deli LLC" />
          </label>
          <fieldset className="span2">
            <legend>Vertical packs</legend>
            {PACK_IDS.map((p) => (
              <label key={p} className="check" style={{ marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={f.packs.includes(p)}
                  onChange={(e) => set({ packs: e.target.checked ? [...f.packs, p] : f.packs.filter((x) => x !== p) })}
                />
                {PACKS[p].label}
                {!PACKS[p].implemented && <span className="muted"> (coming)</span>}
              </label>
            ))}
            <div className="tiny muted">The pack’s starter categories are created (the catalog template); tobacco and lottery get the state’s age check.</div>
          </fieldset>
        </div>
      )}

      {step === 1 && (
        <div className="form-grid">
          <label className="field">
            Owner’s name
            <input value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} />
          </label>
          <label className="field">
            Owner’s mobile <span className="muted">— signs in to the merchant app with a texted code</span>
            <input value={f.ownerPhone} onChange={(e) => set({ ownerPhone: e.target.value })} placeholder="(201) 555-0100" inputMode="tel" />
          </label>
          <p className="muted tiny span2">The owner sets their register PIN and adds staff from the merchant app.</p>
        </div>
      )}

      {step === 2 && (
        <div className="form-grid">
          <label className="field">
            Location name
            <input value={f.locName} onChange={(e) => set({ locName: e.target.value })} />
          </label>
          <label className="field">
            Street address
            <input value={f.address} onChange={(e) => set({ address: e.target.value })} />
          </label>
          <label className="field">
            City
            <input value={f.city} onChange={(e) => set({ city: e.target.value })} />
          </label>
          <label className="field">
            State
            <select
              value={f.state}
              onChange={(e) => {
                const state = e.target.value;
                set({ state, template: state === 'NJ' ? 'NJ' : state === 'NY' ? 'NYC' : '', tax: state === 'NJ' ? '6.625' : state === 'NY' ? '8.875' : f.tax });
              }}
            >
              {['NJ', 'NY', 'PA', 'CT'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            ZIP
            <input value={f.postal} onChange={(e) => set({ postal: e.target.value })} />
          </label>
          <label className="field">
            Sales tax %
            <input value={f.tax} onChange={(e) => set({ tax: e.target.value })} inputMode="decimal" />
          </label>
          <label className="field span2">
            Tax & compliance starting point
            <select value={f.template} onChange={(e) => set({ template: e.target.value as typeof f.template })}>
              <option value="">None — set it up later</option>
              {(Object.keys(STATE_TEMPLATES) as (keyof typeof STATE_TEMPLATES)[]).map((k) => (
                <option key={k} value={k}>
                  {STATE_TEMPLATES[k].title}
                </option>
              ))}
            </select>
            {tpl && <span className="tiny muted">{tpl.notes.join(' ')} Drafts: confirm with the store’s accountant.</span>}
          </label>
        </div>
      )}

      {step === 3 && (
        <div className="form-grid">
          <label className="field span2">
            Plan
            <select value={f.planKind} onChange={(e) => set({ planKind: e.target.value as PricingPlan['kind'] })}>
              {Object.entries(PLAN_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {f.planKind === 'dual_pricing' && (
            <label className="field">
              Card price = cash + (%)
              <input value={f.dual} onChange={(e) => set({ dual: e.target.value })} inputMode="decimal" />
            </label>
          )}
          {f.planKind === 'ic_plus' && (
            <label className="field">
              Interchange + (%)
              <input value={f.markup} onChange={(e) => set({ markup: e.target.value })} inputMode="decimal" />
            </label>
          )}
          {f.planKind === 'flat' && (
            <label className="field">
              Flat rate (%)
              <input value={f.rate} onChange={(e) => set({ rate: e.target.value })} inputMode="decimal" />
            </label>
          )}
          {f.planKind !== 'dual_pricing' && (
            <label className="field">
              + per transaction ($)
              <input value={f.perTxn} onChange={(e) => set({ perTxn: e.target.value })} inputMode="decimal" />
            </label>
          )}
          <label className="field">
            POS subscription per month ($)
            <input value={f.monthly} onChange={(e) => set({ monthly: e.target.value })} inputMode="decimal" />
          </label>
          <label className="field">
            + per extra register per month ($)
            <input value={f.perRegister} onChange={(e) => set({ perRegister: e.target.value })} inputMode="decimal" />
          </label>
        </div>
      )}

      {step === 4 && (
        <div className="form-grid">
          <label className="field">
            Registers
            <select value={f.registers} onChange={(e) => set({ registers: e.target.value })}>
              {Array.from({ length: 10 }, (_, i) => String(i + 1)).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Install date
            <input type="date" value={f.installDate} onChange={(e) => set({ installDate: e.target.value })} />
          </label>
          <label className="field span2">
            Hardware order <span className="muted">— ordered outside the system; note what and the tracking number</span>
            <textarea rows={2} value={f.hardware} onChange={(e) => set({ hardware: e.target.value })} maxLength={500} />
          </label>
          <div className="span2">
            <span className="pill warn">KYB: not started</span>{' '}
            <span className="muted tiny">Business verification runs through the processor once AD Pay LLC’s Finix account exists.</span>
          </div>
        </div>
      )}

      {step === 5 && (
        <div>
          {body.ok ? (
            <ul>
              <li>
                <strong>{body.value.merchant.name}</strong> · {body.value.merchant.enabled_packs.map((p) => PACKS[p].label).join(', ')}
              </li>
              <li>
                Owner {body.value.owner.name}, {body.value.owner.phone}
              </li>
              <li>
                {body.value.location.name}, {[body.value.location.city, body.value.location.state].filter(Boolean).join(', ')} · sales tax {f.tax}%
                {body.value.location.compliance_template ? ` · ${STATE_TEMPLATES[body.value.location.compliance_template].title}` : ''}
              </li>
              <li>
                {PLAN_KIND_LABELS[body.value.pricing.kind]} · ${f.monthly}/month
              </li>
              <li>
                {body.value.registers} register{body.value.registers === 1 ? '' : 's'}
                {body.value.install_date ? ` · install ${body.value.install_date}` : ''}
              </li>
            </ul>
          ) : (
            <div className="error-inline">{body.message}</div>
          )}
        </div>
      )}

      <ErrorBox error={error} />
      <div className="actions-row">
        <button onClick={onCancel}>Cancel</button>
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        {step < steps.length - 1 ? (
          <button className="primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button className="primary" disabled={busy || !body.ok} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create merchant'}
          </button>
        )}
      </div>
    </div>
  );
}
