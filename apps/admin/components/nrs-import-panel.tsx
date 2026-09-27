'use client';
/**
 * Move a store from NRS (ADR 0043, docs/nrs-migration-method.md): upload the price book (portal
 * items JSON with real barcodes, or the CSV export), preview created / updated / unchanged and what
 * can't be carried over, confirm each department's tax and age setting, then import.
 */
import { cents, formatUsd, nrsImportReport, type NrsDepartmentChoices, type NrsImportResponse } from '@adpay/shared';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox } from './ui';

const usd = (c: number) => formatUsd(cents(c));
const AGE = [
  { key: null, label: 'No age check', min_age: null },
  { key: 'tobacco', label: 'Tobacco 21+', min_age: 21 },
  { key: 'vape', label: 'Vape 21+', min_age: 21 },
  { key: 'alcohol', label: 'Alcohol 21+', min_age: 21 },
] as const;

export function NrsImportPanel({ base, onSaved }: { base: string; onSaved: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<NrsImportResponse | null>(null);
  const [done, setDone] = useState<NrsImportResponse | null>(null);
  const [choices, setChoices] = useState<NrsDepartmentChoices>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function run(dry: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<NrsImportResponse>(`${base}/catalog/import/nrs`, { method: 'POST', body: { file: file.text, dry_run: dry, skip_errors: true, departments: choices } });
      if (dry) {
        setPreview(r);
        const next: NrsDepartmentChoices = {};
        for (const d of r.parse.departments) if (!d.exists) next[d.name] = choices[d.name] ?? { taxable: d.taxable, min_age: d.min_age, restriction: d.restriction };
        setChoices(next);
      } else {
        setDone(r);
        setPreview(null);
        onSaved(nrsImportReport(r).headline);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (name: string, patch: Partial<NrsDepartmentChoices[string]>) => setChoices({ ...choices, [name]: { ...choices[name]!, ...patch } });
  const shown = preview ?? done;
  const report = shown ? nrsImportReport(shown) : null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Move from NRS</h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Open'}</button>
      </div>
      {open && (
        <>
          <p className="muted tiny">
            The store&apos;s NRS price book: the portal&apos;s items as JSON (real barcodes; see docs/nrs-migration-method.md) or the portal&apos;s CSV export
            (scrambled barcodes: items get theirs on first scan). Re-uploading updates in place, never duplicates.
          </p>
          <input
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setPreview(null);
              setDone(null);
              setChoices({});
              if (f) void f.text().then((text) => setFile({ name: f.name, text }));
            }}
          />
          <div className="actions-row" style={{ justifyContent: 'flex-start' }}>
            <button disabled={!file || busy} onClick={() => void run(true)}>
              {busy && !preview ? 'Reading…' : 'Preview'}
            </button>
            <button className="primary" disabled={!file || busy || !preview?.result} onClick={() => void run(false)}>
              {busy && preview ? 'Importing…' : preview?.result ? `Import ${preview.result.created + preview.result.updated + preview.result.unchanged} items` : 'Import'}
            </button>
          </div>
          <ErrorBox error={error} />
          {report && (
            <div className="preview">
              <strong>{done ? 'Imported' : 'Preview (nothing saved yet)'}:</strong> {report.headline}
              <ul>
                {report.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {report.unmapped.length > 0 && (
                <>
                  <strong>Couldn&apos;t carry over exactly</strong>
                  <ul>
                    {report.unmapped.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {preview && (
            <div className="grid2">
              <div>
                <h3>Departments → categories</h3>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {preview.parse.departments.map((d) => {
                        const c = choices[d.name];
                        return (
                          <tr key={d.name}>
                            <td>
                              {d.name} <span className="tiny muted">{d.items}</span>
                            </td>
                            {c ? (
                              <>
                                <td>
                                  <select value={c.taxable ? 'y' : 'n'} onChange={(e) => set(d.name, { taxable: e.target.value === 'y' })}>
                                    <option value="y">Taxed</option>
                                    <option value="n">No tax</option>
                                  </select>
                                </td>
                                <td>
                                  <select
                                    value={c.restriction ?? ''}
                                    onChange={(e) => {
                                      const a = AGE.find((x) => (x.key ?? '') === e.target.value)!;
                                      set(d.name, { restriction: a.key, min_age: a.min_age });
                                    }}
                                  >
                                    {AGE.map((a) => (
                                      <option key={a.label} value={a.key ?? ''}>
                                        {a.label}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              </>
                            ) : (
                              <td colSpan={2} className="tiny muted">
                                exists, settings kept
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3>Items to look at</h3>
                <ul className="tiny">
                  {preview.parse.flags.map((f) => (
                    <li key={f.key}>
                      <strong>{f.count}</strong> · {f.label} — e.g. {f.examples.slice(0, 4).join(', ')}
                    </li>
                  ))}
                </ul>
                {preview.result && (
                  <>
                    <h3>First changes</h3>
                    <ul className="tiny">
                      {preview.result.sample.slice(0, 12).map((x, i) => (
                        <li key={i}>
                          {x.action} · {x.name} · {x.from_cents !== null && x.action === 'update' ? `${usd(x.from_cents)} → ` : ''}
                          {usd(x.to_cents)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
