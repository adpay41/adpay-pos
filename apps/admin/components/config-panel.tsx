'use client';
/**
 * Feature flags and vertical packs for one merchant (build plan P12b, Bible 3.4 L52). A change
 * reaches the registers with the next config snapshot (within ~15 s, or instantly over `/ws`).
 */
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, PACKS, PACK_IDS, type FeatureFlag, type FeatureFlagOverrides, type FeatureFlags, type PackId } from '@adpay/shared';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, useLoad } from './ui';

interface Config {
  enabled_packs: PackId[];
  flags: FeatureFlags;
  overrides: FeatureFlagOverrides;
}

export function ConfigPanel({ merchantId }: { merchantId: string }) {
  const cfg = useLoad(() => api<Config>(`/admin/merchants/${merchantId}/config`), [merchantId]);
  const [error, setError] = useState<unknown>(null);

  async function setFlag(k: FeatureFlag, on: boolean) {
    if (!cfg.data) return;
    setError(null);
    const next = { ...cfg.data.overrides };
    // Store only what differs from the default, so a default change later still reaches this merchant.
    if (on === FEATURE_FLAGS[k].default) delete next[k];
    else next[k] = on;
    try {
      await api(`/admin/merchants/${merchantId}/flags`, { method: 'PUT', body: next });
      cfg.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function setPack(p: PackId, on: boolean) {
    if (!cfg.data) return;
    setError(null);
    const next = on ? [...cfg.data.enabled_packs, p] : cfg.data.enabled_packs.filter((x) => x !== p);
    if (next.length === 0) return setError(new Error('A merchant needs at least one pack'));
    try {
      await api(`/admin/merchants/${merchantId}/packs`, { method: 'PUT', body: { enabled_packs: next } });
      cfg.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="panel">
      <h2>Features & packs</h2>
      <ErrorBox error={cfg.error ?? error} />
      {cfg.data && (
        <div className="grid2">
          <div>
            <h3>Feature flags</h3>
            {FEATURE_FLAG_KEYS.map((k) => (
              <label key={k} className="check" style={{ display: 'flex' }}>
                <input type="checkbox" checked={cfg.data!.flags[k]} onChange={(e) => void setFlag(k, e.target.checked)} />
                {FEATURE_FLAGS[k].label}
                <span className="tiny muted">
                  {' '}
                  · {FEATURE_FLAGS[k].where}
                  {k in cfg.data!.overrides ? ' · changed from default' : ''}
                </span>
              </label>
            ))}
          </div>
          <div>
            <h3>Vertical packs</h3>
            {PACK_IDS.map((p) => (
              <label key={p} className="check" style={{ display: 'flex' }}>
                <input type="checkbox" checked={cfg.data!.enabled_packs.includes(p)} onChange={(e) => void setPack(p, e.target.checked)} />
                {PACKS[p].label}
                {!PACKS[p].implemented && <span className="tiny muted"> · stub, adds nothing yet</span>}
              </label>
            ))}
            <p className="tiny muted">Turning a pack on adds its starter categories (skipping names that already exist). Turning it off hides nothing: categories stay.</p>
          </div>
        </div>
      )}
    </div>
  );
}
