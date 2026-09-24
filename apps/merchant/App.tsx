/**
 * AD Pay merchant app — step 1 shell: phone + OTP login against the real API, then today / week /
 * month sales (by tender, hour and register), the latest tickets and the catalog as posted.
 * Item edits, alerts and the live feed arrive in step 5; this exists now so the owner's view of the
 * data can be checked as the foundation is built.
 */
import { cents, formatUsd, type CatalogSnapshot, type SaleListRow, type SalesSummary } from '@adpay/shared';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, tokenStore } from './api';

const C = { red: '#c8102e', black: '#111', ink: '#1d1d1d', muted: '#6b6b6b', line: '#e4e4e4', ground: '#f6f6f6', green: '#0a7f3f' };

/** Money is formatted only at the edge; never red. */
const usd = (v: number) => formatUsd(cents(v));

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    tokenStore.get().then(setToken, () => setToken(null));
  }, []);

  const signOut = useCallback(() => {
    void tokenStore.set(null);
    setToken(null);
  }, []);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.brand}>
          <Text style={s.brandMark}> AD </Text> Pay
        </Text>
        {token ? (
          <Pressable onPress={signOut}>
            <Text style={s.headerLink}>Sign out</Text>
          </Pressable>
        ) : null}
      </View>
      {token === undefined ? (
        <ActivityIndicator style={{ marginTop: 40 }} />
      ) : token ? (
        <Home token={token} onUnauthorized={signOut} />
      ) : (
        <Login
          onToken={(t) => {
            void tokenStore.set(t);
            setToken(t);
          }}
        />
      )}
    </View>
  );
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<{ challenge_id: string; dev_code?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await api('/auth/merchant/otp/request', null, { phone }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/auth/merchant/otp/verify', null, { challenge_id: challenge.challenge_id, code });
      onToken(r.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Sign in</Text>
      {!challenge ? (
        <>
          <Text style={s.label}>Mobile number</Text>
          <TextInput
            style={s.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="(201) 555-0100"
            keyboardType="phone-pad"
            autoComplete="tel"
            onSubmitEditing={request}
          />
          <Button label={busy ? 'Sending…' : 'Text me a code'} onPress={request} disabled={busy || phone.replace(/\D/g, '').length < 10} />
          {__DEV__ ? (
            <Text style={s.muted}>Local demo: (201) 555-0100, then code 123456. No SMS is sent in dev.</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={s.label}>Enter the 6-digit code</Text>
          {challenge.dev_code ? (
            <View style={s.devCode}>
              <Text style={s.muted}>Local dev — no SMS is sent. Your code:</Text>
              <Text style={s.devCodeText}>{challenge.dev_code}</Text>
            </View>
          ) : (
            <Text style={s.muted}>If that number has an account, a code is on its way.</Text>
          )}
          <TextInput
            style={[s.input, { letterSpacing: 6, fontSize: 22 }]}
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="••••••"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            onSubmitEditing={verify}
          />
          <Button label={busy ? 'Checking…' : 'Sign in'} onPress={verify} disabled={busy || code.length !== 6} />
          <Pressable onPress={() => setChallenge(null)}>
            <Text style={[s.muted, { marginTop: 12 }]}>Use a different number</Text>
          </Pressable>
        </>
      )}
      {error ? <Text style={s.error}>{error}</Text> : null}
    </ScrollView>
  );
}

type Tab = 'sales' | 'tickets' | 'items';

function Home({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>('sales');
  const [me, setMe] = useState<{ user: { name: string; merchant_name: string } | null } | null>(null);

  useEffect(() => {
    api<typeof me>('/auth/me', token).then(setMe, (e) => (e.status === 401 ? onUnauthorized() : undefined));
  }, [token, onUnauthorized]);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.subheader}>
        <Text style={s.merchantName}>{me?.user?.merchant_name ?? ' '}</Text>
        <Text style={s.muted}>{me?.user?.name ?? ''}</Text>
      </View>
      <View style={s.tabs}>
        {(['sales', 'tickets', 'items'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabActive]}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>{t === 'sales' ? 'Sales' : t === 'tickets' ? 'Tickets' : 'Items'}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'sales' && <SalesTab token={token} />}
      {tab === 'tickets' && <TicketsTab token={token} />}
      {tab === 'items' && <ItemsTab token={token} />}
    </View>
  );
}

function useApi<T>(path: string, token: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    api<T>(path, token).then(
      (d) => live && setData(d),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [path, token]);
  return { data, error };
}

function SalesTab({ token }: { token: string }) {
  const [range, setRange] = useState<SalesSummary['range']>('today');
  const { data, error } = useApi<SalesSummary>(`/merchant/sales/summary?range=${range}`, token);
  const max = Math.max(1, ...(data?.by_hour.map((h) => h.amount_cents) ?? []));
  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.segment}>
        {(['today', 'week', 'month'] as const).map((r) => (
          <Pressable key={r} onPress={() => setRange(r)} style={[s.segmentItem, range === r && s.segmentActive]}>
            <Text style={[s.segmentText, range === r && { color: '#fff' }]}>
              {r === 'today' ? 'Today' : r === 'week' ? '7 days' : 'Month'}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <>
          <View style={s.card}>
            <Text style={s.label}>Net sales</Text>
            <Text style={s.big}>{usd(data.gross_cents)}</Text>
            <Text style={s.muted}>
              {data.sale_count.toLocaleString('en-US')} tickets · avg {usd(data.sale_count ? Math.round(data.gross_cents / data.sale_count) : 0)} · tax{' '}
              {usd(data.tax_cents)}
            </Text>
          </View>
          <View style={s.row2}>
            {data.by_tender.map((t) => (
              <View key={t.tender_type} style={[s.card, { flex: 1 }]}>
                <Text style={s.label}>{t.tender_type === 'card' ? 'Card' : 'Cash'}</Text>
                <Text style={s.mid}>{usd(t.amount_cents)}</Text>
                <Text style={s.muted}>{t.count} tickets</Text>
              </View>
            ))}
          </View>
          <View style={s.card}>
            <Text style={s.label}>By hour</Text>
            <View style={s.bars}>
              {Array.from({ length: 18 }, (_, i) => i + 5).map((h) => {
                const v = data.by_hour.find((x) => x.hour === h)?.amount_cents ?? 0;
                return <View key={h} style={[s.bar, { height: `${Math.max(2, Math.round((v * 100) / max))}%` }]} />;
              })}
            </View>
            <View style={s.barsX}>
              {['5a', '8a', '11a', '2p', '5p', '8p'].map((l) => (
                <Text key={l} style={s.tiny}>
                  {l}
                </Text>
              ))}
            </View>
          </View>
          <View style={s.card}>
            <Text style={s.label}>By register</Text>
            {data.by_register.map((r) => (
              <View key={r.register_id} style={s.line}>
                <Text style={s.lineName}>{r.register_name}</Text>
                <Text style={s.money}>{usd(r.amount_cents)}</Text>
              </View>
            ))}
          </View>
          <View style={s.card}>
            <View style={s.line}>
              <Text style={s.lineName}>Voids</Text>
              <Text>{data.voids}</Text>
            </View>
            <View style={s.line}>
              <Text style={s.lineName}>Refunds</Text>
              <Text style={s.money}>{usd(data.refunds_cents)}</Text>
            </View>
            <Text style={[s.muted, { marginTop: 8 }]}>Deposits & fees appear here once the processor account is live.</Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function TicketsTab({ token }: { token: string }) {
  const { data, error } = useApi<{ sales: SaleListRow[] }>('/merchant/sales?limit=50', token);
  return (
    <ScrollView contentContainerStyle={s.page}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? <ActivityIndicator /> : null}
      {data?.sales.map((t) => (
        <View key={t.sale_id} style={s.ticket}>
          <View style={{ flex: 1 }}>
            <Text style={s.lineName}>
              {new Date(t.occurred_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · {t.location_name} ·{' '}
              {t.register_name}
            </Text>
            <Text style={s.muted}>
              {t.item_count} {t.item_count === 1 ? 'item' : 'items'} · {t.status === 'completed' ? t.price_mode : t.status}
            </Text>
          </View>
          {t.status === 'completed' ? <Text style={s.money}>{usd(t.total_cents)}</Text> : <Text style={s.voided}>{t.status}</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

function ItemsTab({ token }: { token: string }) {
  const { data, error } = useApi<CatalogSnapshot>('/merchant/catalog', token);
  return (
    <ScrollView contentContainerStyle={s.page}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? <ActivityIndicator /> : null}
      {data?.categories.map((c) => (
        <View key={c.category_id} style={s.card}>
          <Text style={s.label}>
            {c.name}
            {c.min_age ? `  ·  ${c.min_age}+` : ''}
            {!c.taxable ? '  ·  non-taxable' : ''}
          </Text>
          {data.items
            .filter((i) => i.category_id === c.category_id)
            .map((i) => (
              <View key={i.item_id} style={s.line}>
                <Text style={s.lineName}>{i.name}</Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.money}>{usd(i.cash_price_cents)} cash</Text>
                  <Text style={s.mutedSmall}>{usd(i.card_price_cents)} card</Text>
                </View>
              </View>
            ))}
        </View>
      ))}
    </ScrollView>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.button, disabled && { opacity: 0.5 }]}>
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ground },
  header: {
    backgroundColor: C.black,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brand: { color: '#fff', fontSize: 18, fontWeight: '800' },
  brandMark: { backgroundColor: C.red, color: '#fff' },
  headerLink: { color: '#ddd' },
  subheader: { paddingHorizontal: 16, paddingTop: 12 },
  merchantName: { fontSize: 18, fontWeight: '700', color: C.ink },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  tab: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: C.red },
  tabText: { color: C.muted, fontWeight: '600' },
  tabTextActive: { color: C.ink },
  page: { padding: 16, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' },
  h1: { fontSize: 24, fontWeight: '700', color: C.ink, marginBottom: 8 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  button: { backgroundColor: C.red, borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  devCode: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 12 },
  devCodeText: { fontSize: 28, fontWeight: '800', letterSpacing: 6, color: C.ink, marginTop: 4 },
  error: { color: C.red, marginTop: 8 },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  tiny: { color: C.muted, fontSize: 11 },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  big: { fontSize: 34, fontWeight: '800', color: C.black },
  mid: { fontSize: 22, fontWeight: '700', color: C.black },
  row2: { flexDirection: 'row', gap: 12 },
  segment: { flexDirection: 'row', backgroundColor: '#e9e9e9', borderRadius: 8, padding: 3 },
  segmentItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segmentActive: { backgroundColor: C.black },
  segmentText: { fontWeight: '600', color: C.ink },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 110, gap: 3, marginTop: 8 },
  bar: { flex: 1, backgroundColor: C.black, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  barsX: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 12 },
  lineName: { color: C.ink, flexShrink: 1 },
  money: { color: C.black, fontWeight: '600', fontVariant: ['tabular-nums'] },
  voided: { color: C.muted, fontStyle: 'italic' },
  ticket: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
