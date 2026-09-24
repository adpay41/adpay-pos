'use client';
/**
 * Tax & compliance for one location (build plan P10, ADR 0018): a dated sales-tax schedule by tax
 * class, per-unit charges (deposit, excise, fee, bag fee) with dates and the categories they apply
 * to, and age rules by restriction kind with the state's defaults shown. A state template fills the
 * form as a starting point; nothing is saved until Save, and the values need an accountant's sign-off.
 *
 * Amounts are typed as dollars or percent and parsed to integer cents / ppm before they leave the form.
 */
import {
  CHARGE_KINDS,
  ComplianceSettingsInput,
  RESTRICTIONS,
  RESTRICTION_LABELS,
  STATE_TEMPLATES,
  cents,
  formatUsd,
  minAgesFor,
  parseUsdToCents,
  percentToPpm,
  ppmToPercent,
  type CatalogCategory,
  type ChargeKind,
  type ComplianceSnapshot,
  type Restriction,
} from '@adpay/shared';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox } from './ui';

interface Loc {
  location_id: string;
  name: string;
  state: string | null;
}

interface RateRow {
  tax_class: string;
  rate: string;
  from: string;
}

interface ChargeRow {
  rule_id: string;
  kind: ChargeKind;
  label: string;
  /** "$" = fixed amount per unit, "%" = share of the unit price. */
  unit: '$' | '%';
  value: string;
  category_ids: string[];
  item_ids: string[];
  taxable: boolean;
  from: string;
  to: string;
}

const KIND_LABELS: Record<ChargeKind, string> = { excise: 'Excise', deposit: 'Deposit', fee: 'Fee', bag: 'Bag fee (own key)' };
const today = () => new Date().toLocaleDateString('en-CA') /* local YYYY-MM-DD, not UTC */;
const dollars = (c: number) => formatUsd(cents(c)).replace('$', '');

function toForm(c: ComplianceSnapshot) {
  return {
    rates: c.tax_rates.map((r): RateRow => ({ tax_class: r.tax_class, rate: ppmToPercent(r.rate_ppm), from: r.effective_from })),
    charges: c.charges.map(
      (r): ChargeRow => ({
        rule_id: r.rule_id,
        kind: r.kind,
        label: r.label,
        unit: r.amount_cents !== null ? '$' : '%',
        value: r.amount_cents !== null ? dollars(r.amount_cents) : ppmToPercent(r.rate_ppm ?? 0),
        category_ids: r.category_ids,
        item_ids: r.item_ids,
        taxable: r.taxable,
        from: r.effective_from,
        to: r.effective_to ?? '',
      }),
    ),
    ages: Object.fromEntries(RESTRICTIONS.map((k) => [k, c.age_rules[k] ? String(c.age_rules[k]) : ''])) as Record<Restriction, string>,
  };
}

/** Form → the API body. Throws a readable message on the first bad field. */
function toBody(f: ReturnType<typeof toForm>) {
  return ComplianceSettingsInput.parse({
    tax_rates: f.rates.map((r) => ({ tax_class: r.tax_class.trim(), rate_ppm: percentToPpm(r.rate), effective_from: r.from })),
    charges: f.charges.map((r) => ({
      rule_id: r.rule_id,
      kind: r.kind,
      label: r.label.trim(),
      amount_cents: r.unit === '$' ? parseUsdToCents(r.value) : null,
      rate_ppm: r.unit === '%' ? percentToPpm(r.value) : null,
      category_ids: r.kind === 'bag' ? [] : r.category_ids,
      item_ids: r.kind === 'bag' ? [] : r.item_ids,
      taxable: r.taxable,
      effective_from: r.from,
      effective_to: r.to || null,
    })),
    age_rules: Object.fromEntries(RESTRICTIONS.filter((k) => f.ages[k].trim()).map((k) => [k, Number(f.ages[k])])),
  });
}

export function CompliancePanel({
  base,
  loc,
  categories,
  current,
  onSaved,
}: {
  base: string;
  loc: Loc;
  categories: CatalogCategory[];
  current: ComplianceSnapshot;
  onSaved: (msg: string) => void;
}) {
  const [f, setF] = useState(() => toForm(current));
  const [key, setKey] = useState(loc.location_id);
  if (key !== loc.location_id) {
    setKey(loc.location_id);
    setF(toForm(current));
  }
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, body: toBody(f) };
    } catch (e) {
      const issues = (e as { issues?: { message: string }[] }).issues;
      return { ok: false as const, message: issues?.[0]?.message ?? (e as Error).message };
    }
  }, [f]);
  const stateAges = minAgesFor(loc.state, {});
  const catName = (id: string) => categories.find((c) => c.category_id === id)?.name ?? 'removed category';

  const setRate = (i: number, patch: Partial<RateRow>) => setF((p) => ({ ...p, rates: p.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const setCharge = (i: number, patch: Partial<ChargeRow>) => setF((p) => ({ ...p, charges: p.charges.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  function applyTemplate(id: keyof typeof STATE_TEMPLATES) {
    const t = STATE_TEMPLATES[id];
    setF((p) => ({
      ...p,
      rates: t.tax_rates.map((r) => ({ tax_class: r.tax_class, rate: ppmToPercent(r.rate_ppm), from: r.effective_from })),
      charges: t.charges.map((c) => ({
        rule_id: crypto.randomUUID(),
        kind: c.kind,
        label: c.label,
        unit: c.amount_cents !== null ? '$' : '%',
        value: c.amount_cents !== null ? dollars(c.amount_cents) : ppmToPercent(c.rate_ppm ?? 0),
        category_ids: [],
        item_ids: [],
        taxable: c.taxable,
        from: c.effective_from,
        to: c.effective_to ?? '',
      })),
    }));
    setOpen(true);
  }

  async function save() {
    if (!parsed.ok) return setError(new Error(parsed.message));
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ catalog_version: number }>(`${base}/locations/${loc.location_id}/compliance`, { method: 'PUT', body: parsed.body });
      onSaved(`${loc.name}: tax & compliance saved — catalog v${r.catalog_version}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const summary = `${f.rates.length} tax rate${f.rates.length === 1 ? '' : 's'} · ${f.charges.length} charge${f.charges.length === 1 ? '' : 's'}`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Tax & compliance at {loc.name} <span className="muted tiny">{summary}</span>
        </h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Edit'}</button>
      </div>
      {open && (
        <>
          <div className="notice">
            Values are drafts until your accountant signs off. Templates are a starting point; check every number for this store.
          </div>
          <div className="inline" style={{ margin: '8px 0' }}>
            <span className="muted">Start from a template:</span>
            {(Object.keys(STATE_TEMPLATES) as (keyof typeof STATE_TEMPLATES)[]).map((id) => (
              <button key={id} type="button" onClick={() => applyTemplate(id)} title={STATE_TEMPLATES[id].notes.join(' ')}>
                {STATE_TEMPLATES[id].title}
              </button>
            ))}
          </div>

          <h3>Sales tax by class</h3>
          <p className="muted tiny">
            With no rate in force, items use the location’s sales tax above. A class with no rate of its own uses <code>standard</code>. Add a row with a future
            date to change a rate on that day; registers switch at midnight, store time, even offline.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tax class</th>
                  <th>Rate %</th>
                  <th>From</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {f.rates.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input value={r.tax_class} onChange={(e) => setRate(i, { tax_class: e.target.value })} />
                    </td>
                    <td>
                      <input value={r.rate} onChange={(e) => setRate(i, { rate: e.target.value })} inputMode="decimal" style={{ width: 90 }} />
                    </td>
                    <td>
                      <input type="date" value={r.from} onChange={(e) => setRate(i, { from: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" onClick={() => setF((p) => ({ ...p, rates: p.rates.filter((_, j) => j !== i) }))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={() => setF((p) => ({ ...p, rates: [...p.rates, { tax_class: 'standard', rate: '', from: today() }] }))}>
            + Add rate
          </button>

          <h3 style={{ marginTop: 16 }}>Per-unit charges</h3>
          <p className="muted tiny">
            Added to each unit of the items they apply to, at the same amount for cash and card (a percentage follows each price). Printed under the item
            on the receipt. A bag fee gets its own key on the register.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Label on receipt</th>
                  <th>Amount</th>
                  <th>Applies to</th>
                  <th>Taxed</th>
                  <th>From</th>
                  <th>To</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {f.charges.map((r, i) => (
                  <tr key={r.rule_id}>
                    <td>
                      <select value={r.kind} onChange={(e) => setCharge(i, { kind: e.target.value as ChargeKind, ...(e.target.value === 'bag' ? { unit: '$' as const } : {}) })}>
                        {CHARGE_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input value={r.label} onChange={(e) => setCharge(i, { label: e.target.value })} maxLength={32} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <select value={r.unit} onChange={(e) => setCharge(i, { unit: e.target.value as '$' | '%' })} disabled={r.kind === 'bag'}>
                        <option value="$">$ each</option>
                        <option value="%">% of price</option>
                      </select>{' '}
                      <input value={r.value} onChange={(e) => setCharge(i, { value: e.target.value })} inputMode="decimal" style={{ width: 70 }} />
                    </td>
                    <td>
                      {r.kind === 'bag' ? (
                        <span className="muted">its own key</span>
                      ) : (
                        <details>
                          <summary>{r.category_ids.length ? r.category_ids.map(catName).join(', ') : <span className="pill warn">nothing yet</span>}</summary>
                          {categories
                            .filter((c) => c.active)
                            .map((c) => (
                              <label key={c.category_id} className="check" style={{ display: 'flex' }}>
                                <input
                                  type="checkbox"
                                  checked={r.category_ids.includes(c.category_id)}
                                  onChange={(e) =>
                                    setCharge(i, { category_ids: e.target.checked ? [...r.category_ids, c.category_id] : r.category_ids.filter((x) => x !== c.category_id) })
                                  }
                                />
                                {c.name}
                              </label>
                            ))}
                        </details>
                      )}
                    </td>
                    <td>
                      <input type="checkbox" checked={r.taxable} onChange={(e) => setCharge(i, { taxable: e.target.checked })} />
                    </td>
                    <td>
                      <input type="date" value={r.from} onChange={(e) => setCharge(i, { from: e.target.value })} />
                    </td>
                    <td>
                      <input type="date" value={r.to} onChange={(e) => setCharge(i, { to: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" onClick={() => setF((p) => ({ ...p, charges: p.charges.filter((_, j) => j !== i) }))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() =>
              setF((p) => ({
                ...p,
                charges: [...p.charges, { rule_id: crypto.randomUUID(), kind: 'deposit', label: '', unit: '$', value: '0.05', category_ids: [], item_ids: [], taxable: false, from: today(), to: '' }],
              }))
            }
          >
            + Add charge
          </button>

          <h3 style={{ marginTop: 16 }}>Age checks</h3>
          <p className="muted tiny">
            Categories marked tobacco, vape, alcohol or lottery ask for an ID check at this age. Leave empty for the {loc.state ?? 'federal'} default.
          </p>
          <div className="inline">
            {RESTRICTIONS.map((k) => (
              <label key={k} className="field">
                {RESTRICTION_LABELS[k]}
                <input
                  value={f.ages[k]}
                  onChange={(e) => setF((p) => ({ ...p, ages: { ...p.ages, [k]: e.target.value.replace(/\D/g, '').slice(0, 2) } }))}
                  placeholder={`${stateAges[k]}+`}
                  inputMode="numeric"
                  style={{ width: 70 }}
                />
              </label>
            ))}
          </div>

          <ErrorBox error={error ?? (parsed.ok ? null : new Error(parsed.message))} />
          <div className="actions-row">
            <button className="primary" disabled={busy || !parsed.ok} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save tax & compliance'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
