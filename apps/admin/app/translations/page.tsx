'use client';
/**
 * Translations management (build plan P18, Bible 3.4). Every language the customer screen and the
 * receipt speak: whether stores may offer it (draft / available / reviewed, with who reviewed it),
 * how complete it is, and each string beside the English, with corrections that reach every register
 * in its next config snapshot. The built-in translations have not had a professional review.
 */
import { isRtl, type Lang, type LanguageStatus } from '@adpay/shared';
import { useState } from 'react';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface LanguageRow {
  code: Lang;
  name: string;
  native: string;
  status: LanguageStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  translated: number;
  total: number;
  overrides: number;
  locations_asking: number | null;
}
interface StringRow {
  key: string;
  english: string;
  built_in: string | null;
  override: string | null;
}

const STATUS_LABEL: Record<LanguageStatus, string> = { draft: 'Draft — stores can’t offer it', available: 'Offered, not yet reviewed', reviewed: 'Reviewed' };

export default function TranslationsPage() {
  const list = useLoad(() => api<{ languages: LanguageRow[] }>('/admin/translations'), []);
  const [lang, setLang] = useState<Lang | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');

  async function setStatus(code: Lang, status: LanguageStatus) {
    setError(null);
    try {
      await api(`/admin/translations/${code}/status`, { method: 'PUT', body: { status, note: status === 'reviewed' ? note.trim() || null : null } });
      setNote('');
      list.reload();
    } catch (e) {
      setError(e);
    }
  }

  const current = list.data?.languages.find((l) => l.code === lang) ?? null;
  return (
    <Shell>
      <h1>Translations</h1>
      <p className="muted">
        What the customer screen and receipts say in each language. A store offers a language from its receipt settings; a draft is never offered. Changes reach
        every register at its next sync.
      </p>
      <ErrorBox error={list.error ?? error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Language</th>
              <th>Status</th>
              <th className="num">Translated</th>
              <th className="num">Corrections</th>
              <th className="num">Stores asking</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.languages.map((l) => (
              <tr key={l.code} className={l.code === lang ? 'selected' : undefined}>
                <td>
                  {l.name} <span lang={l.code}>{l.native}</span>
                </td>
                <td>
                  <span className={`pill ${l.status === 'reviewed' ? 'ok' : l.status === 'draft' ? 'warn' : ''}`}>{STATUS_LABEL[l.status]}</span>
                  {l.reviewed_by && (
                    <div className="tiny muted">
                      by {l.reviewed_by}
                      {l.reviewed_at ? `, ${new Date(l.reviewed_at).toLocaleDateString()}` : ''}
                      {l.review_note ? ` — ${l.review_note}` : ''}
                    </div>
                  )}
                </td>
                <td className="num">
                  {l.translated}/{l.total}
                </td>
                <td className="num">{l.overrides || ''}</td>
                <td className="num">{l.locations_asking ?? 'all'}</td>
                <td>{l.code !== 'en' && <button onClick={() => setLang(l.code === lang ? null : l.code)}>{l.code === lang ? 'Close' : 'Open'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current && current.code !== 'en' && (
        <div className="panel">
          <h2>
            {current.name} <span lang={current.code}>{current.native}</span>
          </h2>
          <div className="actions-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button disabled={current.status === 'draft'} onClick={() => void setStatus(current.code, 'draft')}>
              Keep as draft
            </button>
            <button disabled={current.status === 'available'} onClick={() => void setStatus(current.code, 'available')}>
              Let stores offer it (unreviewed)
            </button>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who checked it, e.g. “Priya S., native speaker”" maxLength={300} style={{ minWidth: 280 }} />
            <button className="primary" disabled={current.status === 'reviewed'} onClick={() => void setStatus(current.code, 'reviewed')}>
              Mark reviewed
            </button>
          </div>
          <StringsEditor lang={current.code} onChanged={list.reload} />
        </div>
      )}
    </Shell>
  );
}

function StringsEditor({ lang, onChanged }: { lang: Lang; onChanged: () => void }) {
  const s = useLoad(() => api<{ strings: StringRow[] }>(`/admin/translations/${lang}`), [lang]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const dir = isRtl(lang) ? 'rtl' : 'ltr';

  async function save(key: string, text: string | null) {
    setError(null);
    try {
      await api(`/admin/translations/${lang}/strings/${key}`, { method: 'PUT', body: { text } });
      setDraft((d) => {
        const { [key]: _gone, ...rest } = d;
        return rest;
      });
      s.reload();
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <p className="muted tiny">
        Keep every {'{placeholder}'} from the English: it’s where the amount or number goes. Receipt strings (r_…) print on 48-column paper, so keep them short.
      </p>
      <ErrorBox error={s.error ?? error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Where</th>
              <th>English</th>
              <th>In use</th>
              <th>Correction</th>
            </tr>
          </thead>
          <tbody>
            {s.data?.strings.map((r) => {
              const value = draft[r.key] ?? r.override ?? '';
              return (
                <tr key={r.key}>
                  <td className="tiny muted">{r.key.startsWith('r_') ? 'Receipt' : 'Customer screen'}</td>
                  <td>{r.english}</td>
                  <td lang={lang} dir={dir}>
                    {r.override ?? r.built_in ?? <span className="muted">(English)</span>}
                    {r.override && <div className="tiny muted">corrected; built-in: {r.built_in ?? '—'}</div>}
                  </td>
                  <td>
                    <input lang={lang} dir={dir} value={value} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} placeholder={r.built_in ?? r.english} maxLength={200} />{' '}
                    <button disabled={!draft[r.key]?.trim() || draft[r.key] === r.override} onClick={() => void save(r.key, draft[r.key]!.trim())}>
                      Save
                    </button>{' '}
                    {r.override && <button onClick={() => void save(r.key, null)}>Use built-in</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
