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

export async function api<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
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
