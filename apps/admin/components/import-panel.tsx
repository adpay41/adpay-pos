'use client';
/**
 * Catalog templates and CSV import (build plan P14, ADR 0023). Both preview first (a dry run of the
 * exact same write, rolled back) and then apply in one transaction: items matched by barcode, then
 * by name; new ones created; price changes recorded in the price history.
 */
import { cents, formatUsd, type ImportParse } from '@adpay/shared';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, useLoad } from './ui';

interface Template {
  id: string;
  label: string;
  description: string;
  categories: number;
  items: number;
}

interface BulkResult {
  dry_run: boolean;
  created: number;
  updated: number;
  unchanged: number;
  categories_created: string[];
  sample: { line: number | null; name: string; action: 'create' | 'update' | 'unchanged'; from_cents: number | null; to_cents: number }[];
}

const usd = (c: number) => formatUsd(cents(c));

function ResultView({ r }: { r: BulkResult }) {
  return (
    <div className="preview">
      <strong>{r.dry_run ? 'Preview' : 'Done'}:</strong> {r.created} new, {r.updated} updated, {r.unchanged} unchanged
      {r.categories_created.length ? `; new categories: ${r.categories_created.join(', ')}` : ''}.
      <div className="table-wrap">
        <table>
          <tbody>
            {r.sample.map((x, i) => (
              <tr key={i}>
                <td className="tiny muted">{x.line ?? ''}</td>
                <td>{x.name}</td>
                <td>{x.action}</td>
                <td className="num">
                  {x.from_cents !== null && x.action === 'update' ? `${usd(x.from_cents)} → ` : ''}
                  {usd(x.to_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ImportPanel({ base, onSaved }: { base: string; onSaved: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const templates = useLoad(() => (open ? api<{ templates: Template[] }>(`${base}/catalog/templates`) : Promise.resolve(null)), [base, open]);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<{ source: string; parse?: ImportParse; result: BulkResult | null } | null>(null);
  const [skipErrors, setSkipErrors] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function runTemplate(id: string, dry: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<BulkResult>(`${base}/catalog/templates/${id}/apply`, { method: 'POST', body: { dry_run: dry } });
      setPreview({ source: `template:${id}`, result });
      if (!dry) onSaved(`Template applied: ${result.created} new items, ${result.updated} updated`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function runCsv(dry: boolean) {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ parse: ImportParse; result: BulkResult | null }>(`${base}/catalog/import`, { method: 'POST', body: { csv: csv.text, dry_run: dry, skip_errors: skipErrors } });
      setPreview({ source: 'csv', ...r });
      if (!dry && r.result) onSaved(`Imported ${csv.name}: ${r.result.created} new, ${r.result.updated} updated`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Import & templates</h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Open'}</button>
      </div>
      {open && (
        <div className="grid2">
          <div>
            <h3>Start from a template</h3>
            <p className="muted tiny">Names, categories and suggested prices; the store edits prices instead of typing names. Items already in the catalog (same name) are updated to the template price only if you apply.</p>
            {templates.data?.templates.map((t) => (
              <div key={t.id} className="panel">
                <strong>{t.label}</strong>
                <div className="tiny muted">
                  {t.description} ({t.categories} categories, {t.items} items)
                </div>
                <div className="actions-row" style={{ justifyContent: 'flex-start' }}>
                  <button disabled={busy} onClick={() => void runTemplate(t.id, true)}>
                    Preview
                  </button>
                  <button className="primary" disabled={busy || preview?.source !== `template:${t.id}`} onClick={() => void runTemplate(t.id, false)}>
                    Apply
                  </button>
                </div>
              </div>
            ))}
            <p className="tiny muted">A licensed c-store UPC list (2,000 items with barcodes and sizes) will plug in here once the data licence is in place.</p>
          </div>
          <div>
            <h3>Import a spreadsheet (CSV)</h3>
            <p className="muted tiny">
              Export from your old system (NRS, Clover, Square…) or any spreadsheet as CSV. Needs a header row with at least a name and a price column; category,
              UPC/barcode, PLU, SKU, cost and card price are used when present. Matched by barcode first, then by name.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setPreview(null);
                if (file) void file.text().then((text) => setCsv({ name: file.name, text }));
              }}
            />
            <label className="check" style={{ display: 'flex', marginTop: 8 }}>
              <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} /> Import the good lines even if some have problems
            </label>
            <div className="actions-row" style={{ justifyContent: 'flex-start' }}>
              <button disabled={!csv || busy} onClick={() => void runCsv(true)}>
                Preview
              </button>
              <button className="primary" disabled={!csv || busy || preview?.source !== 'csv' || !preview.result} onClick={() => void runCsv(false)}>
                Import
              </button>
            </div>
            {preview?.parse && (
              <div className="tiny muted">
                Columns used: {Object.entries(preview.parse.columns).map(([k, v]) => `${v} → ${k.replace('_cents', '')}`).join(', ') || 'none'}
              </div>
            )}
            {preview?.parse && preview.parse.errors.length > 0 && (
              <div className="error">
                {preview.parse.errors.length} line{preview.parse.errors.length === 1 ? '' : 's'} with problems:
                <ul>
                  {preview.parse.errors.slice(0, 10).map((x, i) => (
                    <li key={i}>
                      line {x.line}: {x.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      <ErrorBox error={templates.error ?? error} />
      {preview?.result && <ResultView r={preview.result} />}
    </div>
  );
}
