'use client';
/**
 * Printable install kit (build plan P12a, Bible 3.1 L43): one card per unpaired register with its
 * setup QR, the code under it, the store's Wi-Fi and the support number. The installer scans the QR
 * with the register's scanner and the register pairs itself.
 *
 * Issuing a kit makes fresh 14-day codes and retires any earlier unused ones. The Wi-Fi details are
 * typed here for printing only: they are never sent to the API or stored.
 */
import QRCode from 'qrcode';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorBox, Shell } from '../../../../components/ui';
import { api } from '../../../../lib/api';

interface Kit {
  merchant_name: string;
  install_date: string | null;
  locations: { location_id: string; name: string; address: string | null; registers: { register_id: string; name: string; code: string; expires_at: string }[] }[];
}

export default function InstallKitPage() {
  const { merchantId } = useParams<{ merchantId: string }>();
  const [kit, setKit] = useState<Kit | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [wifi, setWifi] = useState({ ssid: '', password: '' });
  const [support, setSupport] = useState(process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? '');

  useEffect(() => {
    if (!kit) return;
    let live = true;
    void (async () => {
      const out: Record<string, string> = {};
      // The QR holds only the setup code, which is what a 2D scanner types into the pairing screen.
      for (const r of kit.locations.flatMap((l) => l.registers)) out[r.register_id] = await QRCode.toDataURL(r.code, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      if (live) setQr(out);
    })();
    return () => {
      live = false;
    };
  }, [kit]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      setKit(await api<Kit>(`/admin/merchants/${merchantId}/install-kit`, { method: 'POST' }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const registers = kit?.locations.flatMap((l) => l.registers.map((r) => ({ ...r, location: l }))) ?? [];

  return (
    <Shell>
      <div className="no-print">
        <h1>Install kit</h1>
        <div className="panel">
          <p className="muted">
            One card per register that isn’t paired yet. Issuing makes <strong>fresh codes valid for 14 days</strong> and cancels any unused ones issued
            before.
          </p>
          <div className="form-grid">
            <label className="field">
              Store Wi-Fi name <span className="muted">(printed only)</span>
              <input value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">
              Wi-Fi password <span className="muted">(printed only, never saved)</span>
              <input value={wifi.password} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">
              Support number
              <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder="(201) 555-0199" />
            </label>
          </div>
          <ErrorBox error={error} />
          <div className="actions-row">
            <button className="primary" disabled={busy} onClick={() => void issue()}>
              {busy ? 'Issuing…' : kit ? 'Issue new codes' : 'Issue codes'}
            </button>
            {kit && registers.length > 0 && <button onClick={() => window.print()}>Print</button>}
          </div>
          {kit && registers.length === 0 && <div className="notice">Every register is already paired. Nothing to print.</div>}
        </div>
      </div>

      <div className="kit">
        {registers.map((r) => (
          <section key={r.register_id} className="kit-card">
            <div className="kit-brand">
              <span className="brand-mark">AD</span> Pay — install card
            </div>
            <h2>
              {kit!.merchant_name} · {r.location.name} · {r.name}
            </h2>
            {r.location.address && <div className="muted">{r.location.address}</div>}
            <div className="kit-body">
              {qr[r.register_id] ? <img src={qr[r.register_id]} alt={`Setup QR for ${r.name}`} width={220} height={220} /> : <div className="kit-qr-wait">QR…</div>}
              <ol>
                <li>Plug in the register and the customer screen; connect to the store Wi-Fi.</li>
                <li>On “Set up this register”, scan this QR with the register’s scanner.</li>
                <li>
                  Or type the code: <strong className="kit-code">{r.code}</strong>
                </li>
                <li>The owner signs in with their PIN. Ring a $0.01 test sale and void it.</li>
              </ol>
            </div>
            <div className="kit-foot">
              {wifi.ssid && (
                <span>
                  Wi-Fi <strong>{wifi.ssid}</strong>
                  {wifi.password ? (
                    <>
                      {' '}
                      · password <strong>{wifi.password}</strong>
                    </>
                  ) : null}
                </span>
              )}
              {support && (
                <span>
                  Help: <strong>{support}</strong>
                </span>
              )}
              <span className="muted">Code valid until {new Date(r.expires_at).toLocaleDateString()}</span>
            </div>
          </section>
        ))}
      </div>
    </Shell>
  );
}
