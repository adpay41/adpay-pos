/**
 * AD Pay register.
 *
 *   unpaired  → enter the setup code (the step-4 QR carries the same code) → device token
 *   paired    → boot from the local SQLite store (works offline) → sale screen
 *   ?display=customer (web only) → the customer-facing screen, in its own window
 *
 * Still to come in step 2, on the device: the Kotlin module for the 80mm printer, drawer kick, HID
 * scanner and the Android Presentation customer display. Until then the browser previews them.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { boot, call, tokenStore, Unpaired, type Runtime } from './src/runtime';
import { CustomerScreen } from './src/ui/CustomerScreen';
import { SaleScreen } from './src/ui/SaleScreen';
import { C } from './src/ui/theme';

const isCustomerWindow =
  Platform.OS === 'web' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('display') === 'customer';

export default function App() {
  if (isCustomerWindow) return <CustomerScreen />;
  return <Register />;
}

function Register() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [rt, setRt] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tokenStore.get().then(setToken, () => setToken(null));
  }, []);

  const forget = useCallback(() => {
    rt?.sync.stop();
    rt?.ops.stop();
    setRt(null);
    void tokenStore.set(null);
    setToken(null);
  }, [rt]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setError(null);
    boot(token).then(
      (r) => live && setRt(r),
      (e) => {
        if (!live) return;
        if (e instanceof Unpaired) {
          void tokenStore.set(null);
          setToken(null);
          setError(e.message);
        } else setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <View style={s.root}>
      <StatusBar hidden />
      {token === undefined ? (
        <ActivityIndicator style={{ marginTop: 80 }} />
      ) : !token ? (
        <Pair
          notice={error}
          onPaired={(t) => {
            void tokenStore.set(t);
            setToken(t);
          }}
        />
      ) : rt ? (
        <SaleScreen rt={rt} onForget={forget} />
      ) : error ? (
        <View style={s.center}>
          <Text style={s.error}>{error}</Text>
          <Pressable style={s.ghost} onPress={() => setToken(token.slice())}>
            <Text>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <View style={s.center}>
          <ActivityIndicator />
          <Text style={s.muted}>Opening the local register database…</Text>
        </View>
      )}
    </View>
  );
}

function Pair({ onPaired, notice }: { onPaired: (token: string) => void; notice: string | null }) {
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
    <View style={s.center}>
      <View style={s.pairCard}>
        <Text style={s.pairBrand}>
          <Text style={s.mark}> AD </Text> Pay Register
        </Text>
        <Text style={s.pairTitle}>Set up this register</Text>
        {notice ? <Text style={s.error}>{notice}</Text> : null}
        <Text style={s.muted}>
          Enter the setup code from the admin back-office (Merchants → register → Setup code). In production this arrives as a QR
          the owner scans.
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

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  mark: { backgroundColor: C.red, color: '#fff', fontWeight: '800' },
  muted: { color: C.muted, lineHeight: 20 },
  error: { color: C.red },
  ghost: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10, alignItems: 'center', backgroundColor: '#fff' },
  pairCard: { backgroundColor: '#fff', borderRadius: 12, padding: 28, width: '100%', maxWidth: 460, gap: 12, borderWidth: 1, borderColor: C.line },
  pairBrand: { fontSize: 18, fontWeight: '800', color: C.ink },
  pairTitle: { fontSize: 24, fontWeight: '700', color: C.ink },
  codeInput: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 14, fontSize: 28, letterSpacing: 4, textAlign: 'center', fontWeight: '700', backgroundColor: '#fff' },
  primary: { backgroundColor: C.red, borderRadius: 8, padding: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
