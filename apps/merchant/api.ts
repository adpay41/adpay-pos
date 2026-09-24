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

/** GET a text body (a CSV export). */
export async function apiText(path: string, token: string): Promise<string> {
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, (JSON.parse(text || '{}') as { message?: string }).message ?? `HTTP ${res.status}`);
  return text;
}
