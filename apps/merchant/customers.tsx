/**
 * Customers (Bible 2.7, P19a): the loyalty program in two minutes (a punch card or points, by phone
 * number), the customer list (regulars by spend, visits, texts opt-in) and a promo text to the
 * opted-in regulars. Phone numbers show as their last four digits only.
 */
import { formatUsd, cents, type CatalogCategory, type LoyaltySettings } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

interface CustomerRow {
  customer_ref: string;
  last4: string;
  visits: number;
  spent_cents: number;
  last_visit: string | null;
  texts: 'opted_in' | 'opted_out' | 'no';
}

const usd = (v: number) => formatUsd(cents(v));

export function CustomersTab({ token, canSetUp, canMessage }: { token: string; canSetUp: boolean; canMessage: boolean }) {
  const [data, setData] = useState<{ customers: CustomerRow[]; loyalty: LoyaltySettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    api<{ customers: CustomerRow[]; loyalty: LoyaltySettings }>('/merchant/customers', token).then(setData, (e: Error) => setError(e.message));
  }, [token, nonce]);

  return (
    <ScrollView contentContainerStyle={s.page}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? <ActivityIndicator /> : null}
      {data && canSetUp ? <ProgramEditor token={token} current={data.loyalty} onSaved={() => setNonce((n) => n + 1)} /> : null}
      {data && canMessage ? <PromoComposer token={token} optedIn={data.customers.filter((c) => c.texts === 'opted_in').length} /> : null}
      {data ? (
        <>
          <Text style={s.label}>Customers ({data.customers.length})</Text>
          {data.customers.length === 0 ? <Text style={s.muted}>Customers appear here once they type their number on the customer screen.</Text> : null}
          {data.customers.map((c) => (
            <View key={c.customer_ref} style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>Phone ···{c.last4}</Text>
                <Text style={s.muted}>
                  {c.visits} {c.visits === 1 ? 'visit' : 'visits'}
                  {c.last_visit ? ` · last ${new Date(c.last_visit).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''} ·{' '}
                  {c.texts === 'opted_in' ? 'gets your texts' : c.texts === 'opted_out' ? 'opted out of texts' : 'no texts'}
                </Text>
              </View>
              <Text style={s.money}>{usd(c.spent_cents)}</Text>
              {c.texts === 'opted_in' && canMessage ? (
                <Pressable
                  style={s.small}
                  onPress={() =>
                    void api(`/merchant/customers/${c.customer_ref}/opt-out`, token, {}, 'POST').then(
                      () => setNonce((n) => n + 1),
                      (e: Error) => setError(e.message),
                    )
                  }
                  accessibilityLabel={`Stop texts to phone ending ${c.last4}`}
                >
                  <Text style={s.smallText}>Stop texts</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function ProgramEditor({ token, current, onSaved }: { token: string; current: LoyaltySettings; onSaved: () => void }) {
  const [f, setF] = useState(current);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ categories: CatalogCategory[] }>('/merchant/catalog', token).then((c) => setCategories(c.categories.filter((x) => x.active)), () => undefined);
  }, [token]);
  const reward = f.reward.kind === 'free_item' ? f.reward.max_cents : f.reward.cents;
  const cat = categories.find((c) => c.category_id === f.qualifying_category_id)?.name;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/merchant/loyalty', token, f, 'PUT');
      setMsg('Saved. Registers pick it up at their next sync.');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number.parseInt(v.replace(/\D/g, '') || '0', 10)));
  return (
    <View style={s.card}>
      <Text style={s.h2}>Loyalty program</Text>
      <Pressable onPress={() => setF({ ...f, enabled: !f.enabled })} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: f.enabled }}>
        <View style={[s.box, f.enabled && s.boxOn]} />
        <Text style={s.body}>Customers earn rewards by typing their phone number on the customer screen</Text>
      </Pressable>
      <View style={s.chips}>
        {(['visits', 'points'] as const).map((k) => (
          <Pressable key={k} onPress={() => setF({ ...f, kind: k })} style={[s.chip, f.kind === k && s.chipOn]}>
            <Text style={[s.chipText, f.kind === k && s.chipTextOn]}>{k === 'visits' ? 'Punch card (visits)' : 'Points per dollar'}</Text>
          </Pressable>
        ))}
      </View>
      {f.kind === 'visits' ? (
        <View style={s.line}>
          <Text style={s.body}>Reward every</Text>
          <TextInput style={s.num} value={String(f.visits_needed)} onChangeText={(v) => setF({ ...f, visits_needed: num(v, 2, 20) })} keyboardType="number-pad" accessibilityLabel="Visits for a reward" />
          <Text style={s.body}>visits</Text>
        </View>
      ) : (
        <View style={s.line}>
          <TextInput style={s.num} value={String(f.points_per_dollar)} onChangeText={(v) => setF({ ...f, points_per_dollar: num(v, 1, 20) })} keyboardType="number-pad" accessibilityLabel="Points per dollar" />
          <Text style={s.body}>point(s) per $1; reward at</Text>
          <TextInput style={s.num} value={String(f.points_needed)} onChangeText={(v) => setF({ ...f, points_needed: num(v, 10, 10_000) })} keyboardType="number-pad" accessibilityLabel="Points for a reward" />
          <Text style={s.body}>points</Text>
        </View>
      )}
      <Text style={s.label}>What counts (and what's free)</Text>
      <View style={s.chips}>
        <Pressable onPress={() => setF({ ...f, qualifying_category_id: null })} style={[s.chip, f.qualifying_category_id === null && s.chipOn]}>
          <Text style={[s.chipText, f.qualifying_category_id === null && s.chipTextOn]}>Any purchase</Text>
        </Pressable>
        {categories.map((c) => (
          <Pressable key={c.category_id} onPress={() => setF({ ...f, qualifying_category_id: c.category_id })} style={[s.chip, f.qualifying_category_id === c.category_id && s.chipOn]}>
            <Text style={[s.chipText, f.qualifying_category_id === c.category_id && s.chipTextOn]}>{c.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>Reward</Text>
      <View style={s.chips}>
        <Pressable onPress={() => setF({ ...f, reward: { kind: 'free_item', max_cents: reward } })} style={[s.chip, f.reward.kind === 'free_item' && s.chipOn]}>
          <Text style={[s.chipText, f.reward.kind === 'free_item' && s.chipTextOn]}>A free item{cat ? ` (${cat})` : ''}</Text>
        </Pressable>
        <Pressable onPress={() => setF({ ...f, reward: { kind: 'amount_off', cents: reward } })} style={[s.chip, f.reward.kind === 'amount_off' && s.chipOn]}>
          <Text style={[s.chipText, f.reward.kind === 'amount_off' && s.chipTextOn]}>Money off</Text>
        </Pressable>
      </View>
      <View style={s.line}>
        <Text style={s.body}>{f.reward.kind === 'free_item' ? 'Up to $' : '$'}</Text>
        <TextInput
          style={s.num}
          value={(reward / 100).toFixed(2)}
          onChangeText={(v) => {
            const [d = '0', c = ''] = v.replace(/[^\d.]/g, '').split('.');
            const n = Math.max(1, Math.min(10_000, Number.parseInt(d || '0', 10) * 100 + Number.parseInt((c + '00').slice(0, 2), 10)));
            setF({ ...f, reward: f.reward.kind === 'free_item' ? { kind: 'free_item', max_cents: n } : { kind: 'amount_off', cents: n } });
          }}
          keyboardType="decimal-pad"
          accessibilityLabel="Reward amount in dollars"
        />
        <Text style={s.body}>{f.reward.kind === 'free_item' ? 'the cheapest one on the ticket' : 'off the ticket'}</Text>
      </View>
      <Pressable onPress={() => setF({ ...f, ask_for_texts: !f.ask_for_texts })} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: f.ask_for_texts }}>
        <View style={[s.box, f.ask_for_texts && s.boxOn]} />
        <Text style={s.body}>Ask customers if they want your texts (deals). They tick a box with the legal wording; you only ever see the last four digits.</Text>
      </Pressable>
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
      <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save program'}</Text>
      </Pressable>
    </View>
  );
}

function PromoComposer({ token, optedIn }: { token: string; optedIn: number }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ recipients: number; skipped_recent: number; delivered: boolean }>('/merchant/customers/promo', token, { message, top: 100 }, 'POST');
      const skipped = r.skipped_recent ? ` ${r.skipped_recent} already got one this week.` : '';
      setResult(
        r.delivered
          ? `Sent to ${r.recipients} customers.${skipped}`
          : `Recorded for ${r.recipients} customers, but not delivered: texting isn't connected yet.${skipped}`,
      );
      setMessage('');
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.card}>
      <Text style={s.h2}>Text a deal to your regulars</Text>
      <Text style={s.muted}>
        Goes to your top 100 customers who said yes to texts ({optedIn} so far), at most once a week each. "Reply STOP to opt out." is added for you.
      </Text>
      <TextInput style={[s.input, { minHeight: 70 }]} value={message} onChangeText={setMessage} multiline maxLength={240} placeholder="Free small coffee with any breakfast sandwich, today only" />
      {result ? <Text style={s.muted}>{result}</Text> : null}
      <Pressable style={[s.button, (busy || message.trim().length < 3 || optedIn === 0) && { opacity: 0.5 }]} disabled={busy || message.trim().length < 3 || optedIn === 0} onPress={() => void send()}>
        <Text style={s.buttonText}>{busy ? 'Sending…' : 'Send'}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 10 },
  h2: { fontSize: 17, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginTop: 6 },
  muted: { color: C.muted },
  body: { color: C.ink },
  error: { color: '#8a5300' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12 },
  name: { fontWeight: '700', color: C.ink },
  money: { fontWeight: '700', color: C.ink, fontVariant: ['tabular-nums'] },
  small: { borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  smallText: { color: C.ink, fontSize: 12 },
  check: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: C.muted, marginTop: 1 },
  boxOn: { backgroundColor: C.black, borderColor: C.black },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 64, fontSize: 16, backgroundColor: '#fff' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
