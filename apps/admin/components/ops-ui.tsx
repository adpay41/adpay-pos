'use client';
/** Small shared pieces for the fleet, device and alert pages (P4). */
import { registerHealth, type Alert, type HardwareSlot, type RegisterHealth } from '@adpay/shared';
import { useEffect, useState } from 'react';

const HEALTH_LABEL: Record<RegisterHealth, string> = { online: 'online', stale: 'quiet', offline: 'offline', never: 'never seen' };

/** Re-render every 15 s so "online → quiet → offline" moves without a reload. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function HealthDot({ lastHeartbeatAt, now }: { lastHeartbeatAt: string | null; now: number }) {
  const h = registerHealth(lastHeartbeatAt, now);
  return (
    <span className={`health ${h}`}>
      <span className="dot" /> {HEALTH_LABEL[h]}
    </span>
  );
}

export function Ago({ at, now }: { at: string | null; now: number }) {
  if (!at) return <span className="muted">—</span>;
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  const text = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} d ago`;
  return <span title={new Date(at).toLocaleString()}>{text}</span>;
}

export function HwBadge({ name, slot }: { name: string; slot: HardwareSlot }) {
  const cls = slot.state === 'ok' ? 'ok' : slot.state === 'error' || slot.state === 'offline' ? 'bad' : slot.state === 'warning' ? 'warn' : '';
  return (
    <span className={`pill ${cls}`} title={slot.detail ?? undefined}>
      {name.replace('_', ' ')}: {slot.state}
    </span>
  );
}

export function SeverityPill({ a }: { a: Pick<Alert, 'severity' | 'resolved_at'> }) {
  if (a.resolved_at) return <span className="pill">resolved</span>;
  return <span className={`pill ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : ''}`}>{a.severity}</span>;
}
