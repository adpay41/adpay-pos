'use client';
/**
 * Receipt settings for one location, with a live preview printed from a sample sale by the same
 * shared renderer the register uses (P8): logo, header lines, return policy, footer, QR link, and
 * what happens after a cash sale (ask / always print / no receipt = the zero-tap sale).
 */
import { ReceiptSettingsInput, renderReceipt, sampleReceiptSale, type ReceiptSettings } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { API_URL, api, shrinkPhoto, upload } from '../lib/api';
import { ErrorBox } from './ui';

interface Loc {
  location_id: string;
  name: string;
  city: string | null;
  state: string | null;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

export function ReceiptPanel({ base, loc, merchantName, current, onSaved }: { base: string; loc: Loc; merchantName: string; current: ReceiptSettings & { logo_url: string | null }; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({
    header: current.header_lines.join('\n'),
    policy: current.return_policy ?? '',
    footer: current.footer,
    qrUrl: current.qr?.url ?? '',
    qrCaption: current.qr?.caption ?? 'Scan me',
    after: current.after_sale,
    logo: current.logo_media_id,
    logoUrl: current.logo_url,
  });
  const [key, setKey] = useState(loc.location_id);
  if (key !== loc.location_id) {
    setKey(loc.location_id);
    setF({ header: current.header_lines.join('\n'), policy: current.return_policy ?? '', footer: current.footer, qrUrl: current.qr?.url ?? '', qrCaption: current.qr?.caption ?? 'Scan me', after: current.after_sale, logo: current.logo_media_id, logoUrl: current.logo_url });
  }
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(
    () =>
      ReceiptSettingsInput.safeParse({
        header_lines: f.header.split('\n').map((l) => l.trim()).filter(Boolean),
        logo_media_id: f.logo,
        return_policy: f.policy.trim() || null,
        footer: f.footer.trim() || 'Thank you!',
        qr: f.qrUrl.trim() ? { kind: 'link', url: f.qrUrl.trim(), caption: f.qrCaption.trim() || 'Scan me' } : null,
        after_sale: f.after,
      }),
    [f],
  );
  const preview = useMemo(() => {
    if (!parsed.success) return null;
    return renderReceipt({
      header: { merchant_name: merchantName, location_name: loc.name, address_line1: null, city_state_zip: [loc.city, loc.state].filter(Boolean).join(', ') || null, register_name: 'Register 1' },
      sale: sampleReceiptSale(loc.tax_rate_ppm, loc.dual_price_rate_ppm),
      occurred_at: '2026-09-23T12:15:00.000Z',
      timezone: 'America/New_York',
      copy: 'original',
      settings: parsed.data,
      logo_url: f.logoUrl ? `${API_URL}${f.logoUrl}` : null,
    });
  }, [parsed, merchantName, loc, f.logoUrl]);

  async function chooseLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const up = await upload<{ media_id: string; url: string }>(`${base}/media`, await shrinkPhoto(file, 384, false));
      setF((p) => ({ ...p, logo: up.media_id, logoUrl: up.url }));
    } catch (e) {
      setError(e);
    }
  }

  async function save() {
    if (!parsed.success) return setError(new Error(parsed.error.issues[0]?.message ?? 'Check the fields'));
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ catalog_version: number }>(`${base}/locations/${loc.location_id}/receipt`, { method: 'PUT', body: parsed.data });
      onSaved(`${loc.name}: receipt saved — catalog v${r.catalog_version}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Receipt at {loc.name}</h2>
      <div className="receipt-editor">
        <div className="form-grid" style={{ alignContent: 'start' }}>
          <div className="span2 photo-row">
            {f.logoUrl ? <img src={`${API_URL}${f.logoUrl}`} alt="" className="logo-preview" /> : <div className="photo empty">No logo</div>}
            <div>
              <label className="button-like">
                {f.logoUrl ? 'Replace logo' : 'Add logo'}
                <input type="file" accept="image/*" hidden onChange={(e) => void chooseLogo(e.target.files?.[0])} />
              </label>{' '}
              {f.logoUrl && (
                <button type="button" onClick={() => setF((p) => ({ ...p, logo: null, logoUrl: null }))}>
                  Remove
                </button>
              )}
              <div className="muted tiny">Black on white prints best on thermal paper.</div>
            </div>
          </div>
          <label className="field span2">
            Extra header lines <span className="muted">— up to 4: phone, Instagram, hours</span>
            <textarea rows={3} value={f.header} onChange={(e) => setF({ ...f, header: e.target.value })} />
          </label>
          <label className="field span2">
            Return policy <span className="muted">— leave empty for none</span>
            <textarea rows={2} value={f.policy} onChange={(e) => setF({ ...f, policy: e.target.value })} maxLength={240} />
          </label>
          <label className="field span2">
            Footer
            <input value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} maxLength={96} />
          </label>
          <label className="field">
            QR code link <span className="muted">(optional)</span>
            <input value={f.qrUrl} onChange={(e) => setF({ ...f, qrUrl: e.target.value })} placeholder="https://g.page/r/…/review" />
          </label>
          <label className="field">
            QR caption
            <input value={f.qrCaption} onChange={(e) => setF({ ...f, qrCaption: e.target.value })} maxLength={48} />
          </label>
          <fieldset className="span2">
            <legend>After a cash sale</legend>
            {(
              [
                ['ask', 'Ask each time (print / no receipt)'],
                ['print', 'Always print'],
                ['none', 'No receipt unless asked — fastest: tap Exact and the next customer is up'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="check">
                <input type="radio" checked={f.after === v} onChange={() => setF({ ...f, after: v })} /> {label}
              </label>
            ))}
          </fieldset>
          <div className="span2">
            <ErrorBox error={error ?? (parsed.success ? null : new Error(parsed.error.issues[0]?.message))} />
          </div>
          <div className="span2 actions-row">
            <button className="primary" disabled={busy || !parsed.success} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save receipt'}
            </button>
          </div>
        </div>
        <div className="receipt-paper" aria-label="Receipt preview">
          {preview?.map((l, i) =>
            l.style === 'logo' ? (
              <img key={i} src={l.url} alt="" className="receipt-logo" />
            ) : l.style === 'qr' ? (
              <div key={i} className="receipt-qr">
                ▣ QR
                <div className="tiny">{l.data}</div>
              </div>
            ) : (
              <div key={i} className={`receipt-line ${l.style}`}>
                {l.text || ' '}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
