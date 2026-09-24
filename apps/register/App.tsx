/**
 * AD Pay register — step 1 shell. Pairs with a one-time setup code (the QR flow in step 4 carries
 * the same code), stores the device token, and pulls the versioned catalog snapshot to show the
 * quick-key grid with both posted prices.
 *
 * Not here yet, by design (sequencing step 2): cart, tender, receipt, drawer, the on-device SQLite
 * event log and sync, and the customer display via the Android Presentation API. Tapping a key does
 * a price check — what the customer screen will show — rather than starting a sale.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cents, formatUsd, type CatalogItem, type CatalogSnapshot, type DeviceIdentity } from '@adpay/shared';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'adpay.register.device_token';
const C = { red: '#c8102e', black: '#111', ink: '#1d1d1d', muted: '#6b6b6b', line: '#e4e4e4', ground: '#f2f2f2', green: '#0a7f3f' };
const usd = (v: number) => formatUsd(cents(v));

async function call<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    AsyncStorage.getItem(TOKEN_KEY).then(setToken, () => setToken(null));
  }, []);

  const unpair = useCallback(() => {
    void AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  return (
    <View style={s.root}>
      <StatusBar hidden />
      {token === undefined ? (
        <ActivityIndicator style={{ marginTop: 80 }} />
      ) : token ? (
        <Register token={token} onUnpaired={unpair} />
      ) : (
        <Pair
          onPaired={(t) => {
            void AsyncStorage.setItem(TOKEN_KEY, t);
            setToken(t);
          }}
        />
      )}
    </View>
  );
}

function Pair({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ device_token: string }>('/auth/device/pair', null, { setup_code: code });
      onPaired(r.device_token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.pairWrap}>
      <View style={s.pairCard}>
        <Text style={s.pairBrand}>
          <Text style={s.brandMark}> AD </Text> Pay Register
        </Text>
        <Text style={s.pairTitle}>Set up this register</Text>
        <Text style={s.muted}>
          Enter the setup code from the admin back-office (Merchants → register → Setup code). In production this arrives as a QR the
          owner scans.
        </Text>
        {__DEV__ ? (
          <Text style={s.muted}>Local demo: JSQ3-DEMO (Jersey City · Register 3). More codes are in the README.</Text>
        ) : null}
        <TextInput
          style={s.codeInput}
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABCD-2345"
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={pair}
        />
        {error ? <Text style={s.error}>{error}</Text> : null}
        <Pressable style={[s.primary, (busy || code.replace(/[^A-Z0-9]/gi, '').length < 8) && { opacity: 0.5 }]} onPress={pair} disabled={busy}>
          <Text style={s.primaryText}>{busy ? 'Pairing…' : 'Pair register'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Register({ token, onUnpaired }: { token: string; onUnpaired: () => void }) {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [checked, setChecked] = useState<CatalogItem | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [id, snap] = await Promise.all([
        call<DeviceIdentity>('/device/identity', token),
        call<CatalogSnapshot>('/device/catalog', token),
      ]);
      setIdentity(id);
      setCatalog(snap);
      setCategory((c) => c ?? snap.categories[0]?.category_id ?? null);
    } catch (e) {
      if ((e as { status?: number }).status === 401) onUnpaired();
      else setError((e as Error).message);
    }
  }, [token, onUnpaired]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => catalog?.items.filter((i) => i.active && i.category_id === category) ?? [], [catalog, category]);

  if (!catalog || !identity) {
    return (
      <View style={s.pairWrap}>
        {error ? <Text style={s.error}>{error}</Text> : <ActivityIndicator />}
        {error ? (
          <Pressable style={s.ghost} onPress={() => void load()}>
            <Text>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={s.topbar}>
        <Text style={s.topBrand}>
          <Text style={s.brandMark}> AD </Text> Pay
        </Text>
        <Text style={s.topWhere} numberOfLines={1}>
          {identity.merchant_name} · {identity.location_name} · {identity.register_name}
        </Text>
        <Pressable onPress={() => setShowInfo((v) => !v)}>
          <Text style={s.topLink}>Device</Text>
        </Pressable>
      </View>

      <View style={s.body}>
        <View style={s.catCol}>
          {catalog.categories.map((c) => (
            <Pressable key={c.category_id} onPress={() => setCategory(c.category_id)} style={[s.cat, category === c.category_id && s.catActive]}>
              <Text style={[s.catText, category === c.category_id && { color: '#fff' }]}>{c.name}</Text>
              {c.min_age ? <Text style={[s.catAge, category === c.category_id && { color: '#ddd' }]}>{c.min_age}+</Text> : null}
            </Pressable>
          ))}
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.grid}>
          {items.map((i) => (
            <Pressable key={i.item_id} onPress={() => setChecked(i)} style={[s.key, checked?.item_id === i.item_id && s.keyActive]}>
              <Text style={s.keyName} numberOfLines={3}>
                {i.name}
              </Text>
              <View>
                <Text style={s.keyCash}>{usd(i.cash_price_cents)}</Text>
                <Text style={s.keyCard}>card {usd(i.card_price_cents)}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>

        <View style={s.side}>
          {showInfo ? (
            <DeviceInfo identity={identity} catalog={catalog} onUnpair={onUnpaired} onRefresh={load} />
          ) : (
            <>
              <Text style={s.sideLabel}>Customer screen preview</Text>
              {checked ? (
                <View style={s.customer}>
                  <Text style={s.customerItem}>{checked.name}</Text>
                  <View style={s.dual}>
                    <View style={s.dualBox}>
                      <Text style={s.dualLabel}>Cash price</Text>
                      <Text style={s.dualValue}>{usd(checked.cash_price_cents)}</Text>
                    </View>
                    <View style={s.dualBox}>
                      <Text style={s.dualLabel}>Card price</Text>
                      <Text style={s.dualValue}>{usd(checked.card_price_cents)}</Text>
                    </View>
                  </View>
                  <Text style={s.mutedSmall}>
                    {checked.taxable ? 'plus sales tax' : 'no sales tax'}
                    {checked.min_age ? ` · ID check ${checked.min_age}+` : ''}
                    {checked.sell_unit === 'pack' ? ` · pack of ${checked.pack_qty}` : ''}
                  </Text>
                </View>
              ) : (
                <View style={s.customer}>
                  <Text style={s.customerIdle}>
                    <Text style={s.brandMark}> AD </Text> Pay
                  </Text>
                  <Text style={s.mutedSmall}>Tap a key to price-check it.</Text>
                </View>
              )}
              <View style={s.step2}>
                <Text style={s.step2Title}>Sale flow — build step 2</Text>
                <Text style={s.mutedSmall}>
                  Cart, cash tender, receipt, drawer, offline SQLite event log and sync come next. This screen proves pairing, device
                  auth and the catalog snapshot end to end.
                </Text>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function DeviceInfo({
  identity,
  catalog,
  onUnpair,
  onRefresh,
}: {
  identity: DeviceIdentity;
  catalog: CatalogSnapshot;
  onUnpair: () => void;
  onRefresh: () => Promise<void>;
}) {
  const pct = (ppm: number) => `${Math.trunc(ppm / 10_000)}.${String(ppm % 10_000).padStart(4, '0').replace(/0+$/, '') || '0'}%`;
  const rows: [string, string][] = [
    ['Register id', identity.register_id],
    ['Location id', identity.location_id],
    ['Merchant id', identity.merchant_id],
    ['Packs', identity.enabled_packs.join(', ')],
    ['Catalog', `v${catalog.catalog_version} · ${catalog.items.length} items`],
    ['Tax rate', pct(catalog.tax_rate_ppm)],
    ['Card price', `cash + ${pct(catalog.dual_price_rate_ppm)}`],
    ['API', API_URL],
  ];
  return (
    <ScrollView>
      <Text style={s.sideLabel}>Device</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={s.infoRow}>
          <Text style={s.mutedSmall}>{k}</Text>
          <Text style={s.infoValue} selectable>
            {v}
          </Text>
        </View>
      ))}
      <Pressable style={s.ghost} onPress={() => void onRefresh()}>
        <Text>Resync catalog</Text>
      </Pressable>
      <Pressable style={s.ghost} onPress={onUnpair}>
        <Text>Forget pairing on this device</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ground },
  brandMark: { backgroundColor: C.red, color: '#fff', fontWeight: '800' },
  muted: { color: C.muted, lineHeight: 20 },
  mutedSmall: { color: C.muted, fontSize: 12, lineHeight: 17 },
  error: { color: C.red, marginVertical: 8 },

  pairWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pairCard: { backgroundColor: '#fff', borderRadius: 12, padding: 28, width: '100%', maxWidth: 460, gap: 12, borderWidth: 1, borderColor: C.line },
  pairBrand: { fontSize: 18, fontWeight: '800', color: C.ink },
  pairTitle: { fontSize: 24, fontWeight: '700', color: C.ink },
  codeInput: {
    borderWidth: 1,
    borderColor: '#cfcfcf',
    borderRadius: 8,
    padding: 14,
    fontSize: 28,
    letterSpacing: 4,
    textAlign: 'center',
    fontWeight: '700',
    backgroundColor: '#fff',
  },
  primary: { backgroundColor: C.red, borderRadius: 8, padding: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ghost: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10, alignItems: 'center', marginTop: 10, backgroundColor: '#fff' },

  topbar: { backgroundColor: C.black, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 52, gap: 16 },
  topBrand: { color: '#fff', fontSize: 18, fontWeight: '800' },
  topWhere: { color: '#ddd', flex: 1 },
  topLink: { color: '#ddd' },

  body: { flex: 1, flexDirection: 'row' },
  catCol: { width: 150, backgroundColor: '#fff', borderRightWidth: 1, borderRightColor: C.line, paddingVertical: 8 },
  cat: { paddingVertical: 16, paddingHorizontal: 14, marginHorizontal: 8, marginVertical: 3, borderRadius: 8, flexDirection: 'row', justifyContent: 'space-between' },
  catActive: { backgroundColor: C.black },
  catText: { fontWeight: '700', color: C.ink, fontSize: 15 },
  catAge: { color: C.muted, fontSize: 12, fontWeight: '600' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 10, alignContent: 'flex-start' },
  key: {
    width: 150,
    height: 112,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 10,
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: C.line,
  },
  keyActive: { borderColor: C.black },
  keyName: { fontWeight: '600', color: C.ink, fontSize: 14 },
  keyCash: { color: C.black, fontWeight: '800', fontSize: 16, fontVariant: ['tabular-nums'] },
  keyCard: { color: C.muted, fontSize: 12, fontVariant: ['tabular-nums'] },

  side: { width: 300, borderLeftWidth: 1, borderLeftColor: C.line, backgroundColor: '#fff', padding: 16 },
  sideLabel: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700', marginBottom: 10 },
  customer: { backgroundColor: C.ground, borderRadius: 10, padding: 16, gap: 12, minHeight: 170, justifyContent: 'center' },
  customerIdle: { fontSize: 28, fontWeight: '800', color: C.ink, textAlign: 'center' },
  customerItem: { fontSize: 18, fontWeight: '700', color: C.ink },
  dual: { flexDirection: 'row', gap: 10 },
  dualBox: { flex: 1, backgroundColor: '#fff', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: C.line },
  dualLabel: { fontSize: 12, color: C.muted, fontWeight: '600' },
  dualValue: { fontSize: 24, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  step2: { marginTop: 16, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, gap: 4 },
  step2Title: { fontWeight: '700', color: C.ink },
  infoRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line },
  infoValue: { color: C.ink, fontSize: 13 },
});
