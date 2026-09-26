import AsyncStorage from '@react-native-async-storage/async-storage';

// On a phone, set EXPO_PUBLIC_API_URL to the laptop's LAN address (http://192.168.x.x:3000).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const KEY = 'adpay.merchant.token';

export const tokenStore = {
  get: () => AsyncStorage.getItem(KEY),
  set: (token: string | null) => (token ? AsyncStorage.setItem(KEY, token) : AsyncStorage.removeItem(KEY)),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET without a body, POST with one; pass `method` for PATCH / PUT. */
export async function api<T>(path: string, token: string | null, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT'): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
  return data as T;
}

/** POST a raw binary body (a product photo). */
export async function upload<T>(path: string, token: string, body: Blob, contentType: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
  return data as T;
}

/** Absolute URL for a path the API returned (e.g. an item's `image_url`). */
export const apiUrl = (path: string) => `${API_URL}${path}`;

/**
 * POST for a PDF (shelf tags, price labels, P21) and open it in a new tab to print. Printing needs a
 * computer or a phone browser with a print dialog; the native app reports that instead.
 */
export async function openPdf(path: string, token: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
  }
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') throw new ApiError(0, 'Open the merchant app in a browser to print labels');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
