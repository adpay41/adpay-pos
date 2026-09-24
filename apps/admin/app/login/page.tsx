'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorBox } from '../../components/ui';
import { api, setToken } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/auth/admin/login', { method: 'POST', body: { email, password } });
      setToken(r.token);
      router.replace('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login panel">
      <h1>
        <span className="brand-mark" style={{ background: 'var(--red)', color: '#fff', padding: '2px 7px', borderRadius: 4 }}>
          AD
        </span>{' '}
        Pay admin
      </h1>
      <form onSubmit={submit}>
        <label className="field">
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {process.env.NODE_ENV === 'development' && (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Local demo (dev builds only): <code>admin@adpay.local</code> / <code>adpay-demo</code>
          </p>
        )}
      </form>
    </div>
  );
}
