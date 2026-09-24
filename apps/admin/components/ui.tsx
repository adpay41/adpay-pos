'use client';
import { cents, formatUsd } from '@adpay/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getToken, setToken } from '../lib/api';

/** Money is formatted only here, at the edge. Never red. Green only when it means "approved". */
export function Money({ cents: value, approved = false }: { cents: number; approved?: boolean }) {
  return <span className={`money${approved ? ' approved' : ''}`}>{formatUsd(cents(value))}</span>;
}

export function Pct({ ppm }: { ppm: number }) {
  // Display only: ppm → percent with up to 4 decimals, no float arithmetic on money.
  const whole = Math.trunc(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, '0').replace(/0+$/, '');
  return <span>{frac ? `${whole}.${frac}` : whole}%</span>;
}

export function When({ at }: { at: string | null }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return <span title={d.toISOString()}>{d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'completed' || status === 'active' || status === 'approved'
      ? 'ok'
      : status === 'voided' || status === 'retired' || status === 'declined'
        ? 'bad'
        : 'warn';
  return <span className={`pill ${cls}`}>{status}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="error">{msg}</div>;
}

const NAV = [
  { href: '/', label: 'Merchants' },
  { href: '/onboarding', label: 'Onboarding' },
  { href: '/fleet', label: 'Fleet' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/support', label: 'Support' },
  { href: '/sales', label: 'Sales' },
  { href: '/money', label: 'Money' },
  { href: '/tax', label: 'Tax' },
  { href: '/audit', label: 'Audit log' },
];

/** Page chrome + auth guard. Pages render only once a token is present. */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) router.replace('/login');
    else setReady(true);
  }, [router]);

  if (!ready) return null;
  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="brand-mark">AD</span> Pay <span className="muted" style={{ fontWeight: 400 }}>admin</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path === n.href || (n.href !== '/' && path.startsWith(n.href)) ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <button
          onClick={() => {
            setToken(null);
            router.replace('/login');
          }}
        >
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </>
  );
}

/** Small data hook: load on mount / when deps change, expose reload. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(
      (d) => live && setData(d),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}
