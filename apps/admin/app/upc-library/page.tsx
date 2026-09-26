'use client';
/**
 * The global UPC library (Bible 3.4; P25c, ADR 0041): every real product barcode in any store's
 * catalog, deduped on the barcode key, with the name most stores use. "Names disagree" lists the
 * barcodes stores call different things. Store-made codes never appear. Seeding from a licensed UPC
 * dataset is a separate item waiting on the licence.
 */
import { cents, formatUsd, type UpcSuggestion } from '@adpay/shared';
import { useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Overview {
  gtins: number;
  shared: number;
  conflicts: number;
  rows: { barcode_key: string; barcode: string; name: string; stores: number; variants: number }[];
}

export default function UpcLibraryPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [conflicts, setConflicts] = useState(false);
  const lib = useLoad(() => api<Overview>(`/admin/upc-library?conflicts=${conflicts ? 1 : 0}${query ? `&search=${encodeURIComponent(query)}` : ''}`), [conflicts, query]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Shell>
      <h1>UPC library</h1>
      <ErrorBox error={lib.error} />
      {lib.data ? (
        <p className="muted">
          {lib.data.gtins} product barcodes across all stores · {lib.data.shared} carried by more than one store · {lib.data.conflicts} where stores use different names
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(search.trim())} placeholder="Name or barcode" />
        <button onClick={() => setQuery(search.trim())}>Search</button>
        <label className="check">
          <input type="checkbox" checked={conflicts} onChange={(e) => setConflicts(e.target.checked)} /> Names disagree
        </label>
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Barcode</th>
              <th>Name (most stores)</th>
              <th className="num">Stores</th>
              <th className="num">Names</th>
            </tr>
          </thead>
          <tbody>
            {lib.data?.rows.map((r) => (
              <tr key={r.barcode_key} onClick={() => setOpen(open === r.barcode ? null : r.barcode)} style={{ cursor: 'pointer' }}>
                <td className="mono">{r.barcode}</td>
                <td>
                  {r.name}
                  {open === r.barcode ? <Detail code={r.barcode} /> : null}
                </td>
                <td className="num">{r.stores}</td>
                <td className="num">{r.variants > 1 ? <span className="pill warn">{r.variants}</span> : 1}</td>
              </tr>
            ))}
            {lib.data?.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing matches.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function Detail({ code }: { code: string }) {
  const d = useLoad(() => api<{ suggestion: UpcSuggestion | null }>(`/admin/upc/${code}`), [code]);
  const s = d.data?.suggestion;
  if (!s) return null;
  return (
    <div className="tiny muted" style={{ marginTop: 4 }}>
      {s.names.map((n) => `“${n.name}” (${n.stores})`).join(' · ')}
      {s.category ? ` · ${s.category}` : ''}
      {s.typical_cash_cents !== null ? ` · usually ${formatUsd(cents(s.typical_cash_cents))}` : ' · price shown from 3 stores'}
    </div>
  );
}
