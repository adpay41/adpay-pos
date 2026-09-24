/**
 * Boots the register: local store → cached identity and catalog → session → background sync.
 * Everything the register needs to sell is local; the network only ever adds freshness.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogSnapshot, DeviceIdentity } from '@adpay/shared';
import * as Crypto from 'expo-crypto';
import { SaleSession } from './core/session';
import { SqliteEventStore } from './core/sqlite-store';
import { StaffGate } from './core/staff';
import type { EventStore } from './core/store';
import { SyncEngine, type Transport } from './core/sync';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'adpay.register.device_token';
const IDENTITY_KEY = 'identity';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const tokenStore = {
  get: () => AsyncStorage.getItem(TOKEN_KEY),
  set: (t: string | null) => (t ? AsyncStorage.setItem(TOKEN_KEY, t) : AsyncStorage.removeItem(TOKEN_KEY)),
};

let storePromise: Promise<EventStore> | null = null;
export function openStore(): Promise<EventStore> {
  storePromise ??= SqliteEventStore.open();
  return storePromise;
}

export interface Runtime {
  store: EventStore;
  identity: DeviceIdentity;
  catalog: CatalogSnapshot;
  session: SaleSession;
  sync: SyncEngine;
  staff: StaffGate;
}

/** Thrown when the device token is no longer valid (re-paired elsewhere, revoked). */
export class Unpaired extends Error {}

export async function boot(token: string): Promise<Runtime> {
  const store = await openStore();

  let identity: DeviceIdentity | null;
  try {
    identity = await call<DeviceIdentity>('/device/identity', token);
    await store.setMeta(IDENTITY_KEY, JSON.stringify(identity));
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw new Unpaired('This register was re-paired or revoked');
    const cached = await store.getMeta(IDENTITY_KEY);
    identity = cached ? (JSON.parse(cached) as DeviceIdentity) : null;
  }
  if (!identity) throw new Error('Cannot reach the server and this register has never synced. Connect once to finish setup.');

  const transport: Transport = {
    pushEvents: (events) => call('/device/events', token, { events }),
    pullCatalog: () => call<CatalogSnapshot>('/device/catalog', token),
    catalogVersion: async () => (await call<{ catalog_version: number }>('/device/catalog/version', token)).catalog_version,
  };
  const sync = new SyncEngine(store, transport);
  const catalog = await sync.pullCatalog();
  if (!catalog) throw new Error('No catalog yet. Connect once so the register can download it.');

  let currentCatalogVersion = catalog.catalog_version;
  sync.subscribe((s) => {
    if (s.catalogVersion !== null) currentCatalogVersion = s.catalogVersion;
  });

  const session = new SaleSession({
    store,
    tenancy: {
      org_id: identity.org_id,
      merchant_id: identity.merchant_id,
      location_id: identity.location_id,
      register_id: identity.register_id,
    },
    catalogVersion: () => currentCatalogVersion,
    uuid: () => Crypto.randomUUID(),
  });
  await session.restore();
  // Who may sign in comes with the config snapshot; a newer snapshot refreshes it (P3).
  const staff = new StaffGate(store, session);
  await staff.restore(catalog.staff);
  sync.onCatalog((c) => void staff.update(c.staff));
  // Every sale action is pushed as soon as possible; offline, the engine just keeps it queued.
  session.subscribe(() => sync.kick());
  await sync.start();
  return { store, identity, catalog, session, sync, staff };
}
