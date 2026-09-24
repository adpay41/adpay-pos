'use client';
/**
 * Browser client for the AD Pay API.
 *
 * Step 1 keeps the admin token in sessionStorage (cleared when the tab closes). Before this runs
 * anywhere but a developer's machine it moves to an httpOnly cookie set by a Next route handler,
 * using ADMIN_SESSION_SECRET — tracked in docs/design/step-1-foundation.md.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const KEY = 'adpay.admin.token';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: stay logged out */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly traceId: string | null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/admin/login') setToken(null);
    throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`, res.headers.get('x-trace-id'));
  }
  return data as T;
}
