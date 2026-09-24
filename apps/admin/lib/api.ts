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

/** POST a raw binary body (a product photo) and parse the JSON reply. */
export async function upload<T>(path: string, body: Blob): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': body.type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`, res.headers.get('x-trace-id'));
  return data as T;
}

/**
 * Square-crop and shrink a chosen photo to a 512px JPEG in the browser before upload, so product
 * photos are tens of KB and the API's 1 MB cap is never the thing that stops an owner.
 */
export async function shrinkPhoto(file: File, edge = 512): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(edge, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize photos');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', 0.72),
  );
}
