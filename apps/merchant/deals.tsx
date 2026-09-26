/**
 * Deals (Bible 2.3 promotions builder, 1.5 deals of the day; P20a): "2 for $5", buy X get Y, a happy
 * hour, for chosen items or whole categories, with dates, days and hours, per store. Registers apply
 * them as the ticket changes; the customer screen shows the running ones while idle.
 */
import { cents, formatUsd, localDate, PromotionInput, promotionText, type CatalogSnapshot, type Promotion, type PromotionRule } from '@adpay/shared';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

type Listed = Promotion & { uses_30d: number; given_30d_cents: number };
const usd = (v: number) => formatUsd(cents(v));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function DealsTab({ token }: { token: string }) {
  const [list, setList] = useState<Listed[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [editing, setEditing] = useState<Listed | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    api<{ promotions: Listed[] }>('/merchant/promotions', token).then((r) => setList(r.promotions), (e: Error) => setError(e.message));
    api<CatalogSnapshot>('/merchant/catalog', token).then(setCatalog, () => undefined);
  }, [token, nonce]);

  async function toggle(p: Listed) {
    try {
      await api(`/merchant/promotions/${p.promo_id}/${p.active ? 'end' : 'resume'}`, token, {}, 'POST');
      setNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (editing && catalog)
    return (
      <DealEditor
        token={token}
        catalog={catalog}
        current={editing === 'new' ? null : editing}
        onDone={(msg) => {
          setEditing(null);
          setError(msg);
          setNonce((n) => n + 1);
        }}
      />
    );
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Pressable style={s.button} onPress={() => setEditing('new')}>
        <Text style={s.buttonText}>New deal</Text>
      </Pressable>
      {error ? <Text style={s.muted}>{error}</Text> : null}
      {!list ? <ActivityIndicator /> : null}
      {list?.length === 0 ? <Text style={s.muted}>No deals yet. “2 for $5” on energy drinks is a good first one.</Text> : null}
      {list?.map((p) => (
        <Pressable key={p.promo_id} style={[s.card, !p.active && { opacity: 0.6 }]} onPress={() => setEditing(p)} accessibilityRole="button">
          <Text style={s.name}>{promotionText(p)}</Text>
          <Text style={s.muted}>
            {p.active ? 'Running' : 'Ended'} · from {p.starts_on}
            {p.ends_on ? ` to ${p.ends_on}` : ''}
            {p.days ? ` · ${p.days.map((d) => DAYS[d]).join(' ')}` : ''}
            {p.start_time ? ` · ${p.start_time}–${p.end_time}` : ''}
          </Text>
          <Text style={s.muted}>
            Last 30 days: {p.uses_30d} tickets, {usd(p.given_30d_cents)} off{p.show_on_idle ? ' · on the customer screen' : ''}
          </Text>
          <Pressable style={s.small} onPress={() => void toggle(p)}>
            <Text style={s.smallText}>{p.active ? 'End now' : 'Run again'}</Text>
          </Pressable>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function DealEditor({ token, catalog, current, onDone }: { token: string; catalog: CatalogSnapshot; current: Listed | null; onDone: (msg: string | null) => void }) {
  const today = localDate(new Date(), 'America/New_York');
  const [name, setName] = useState(current?.name ?? '');
  const [rule, setRule] = useState<PromotionRule>(current?.rule ?? { kind: 'multi_price', qty: 2, price_cents: 500 });
  const [itemIds, setItemIds] = useState<string[]>(current?.item_ids ?? []);
  const [categoryIds, setCategoryIds] = useState<string[]>(current?.category_ids ?? []);
  const [startsOn, setStartsOn] = useState(current?.starts_on ?? today);
  const [endsOn, setEndsOn] = useState(current?.ends_on ?? '');
  const [days, setDays] = useState<number[] | null>(current?.days ?? null);
  const [hours, setHours] = useState(current?.start_time ? `${current.start_time}-${current.end_time}` : '');
  const [idle, setIdle] = useState(current?.show_on_idle ?? true);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [start_time, end_time] = hours.includes('-') ? hours.split('-').map((x) => x.trim()) : [null, null];
  const parsed = PromotionInput.safeParse({
    name: name.trim() || (rule.kind === 'multi_price' ? `${rule.qty} for ${usd(rule.price_cents)}` : rule.kind === 'buy_get' ? `Buy ${rule.buy} get ${rule.get}` : `${rule.percent_off}% off`),
    rule, item_ids: itemIds, category_ids: categoryIds, location_ids: null, starts_on: startsOn, ends_on: endsOn || null, days, start_time: start_time ?? null, end_time: end_time ?? null, show_on_idle: idle,
  });
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q.length < 2 ? [] : catalog.items.filter((i) => i.active && i.name.toLowerCase().includes(q)).slice(0, 12);
  }, [search, catalog]);
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number.parseInt(v.replace(/\D/g, '') || '0', 10)));
  const money = (v: string) => {
    const [d = '0', c = ''] = v.replace(/[^\d.]/g, '').split('.');
    return Math.max(1, Number.parseInt(d || '0', 10) * 100 + Number.parseInt((c + '00').slice(0, 2), 10));
  };

  async function save() {
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the fields');
    setBusy(true);
    setError(null);
    try {
      if (current) await api(`/merchant/promotions/${current.promo_id}`, token, parsed.data, 'PUT');
      else await api('/merchant/promotions', token, parsed.data, 'POST');
      onDone('Saved. Registers pick it up at their next sync.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chip = (on: boolean, label: string, onPress: () => void, key?: string) => (
    <Pressable key={key ?? label} onPress={onPress} style={[s.chip, on && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
  const itemName = (id: string) => catalog.items.find((i) => i.item_id === id)?.name ?? 'item';

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h2}>{current ? 'Edit deal' : 'New deal'}</Text>
      <View style={s.chips}>
        {chip(rule.kind === 'multi_price', 'N for $X', () => setRule({ kind: 'multi_price', qty: 2, price_cents: 500 }))}
        {chip(rule.kind === 'buy_get', 'Buy X get Y', () => setRule({ kind: 'buy_get', buy: 1, get: 1, percent_off: 100 }))}
        {chip(rule.kind === 'percent_off', '% off (happy hour)', () => setRule({ kind: 'percent_off', percent_off: 20 }))}
      </View>
      {rule.kind === 'multi_price' ? (
        <View style={s.line}>
          <TextInput style={s.num} value={String(rule.qty)} onChangeText={(v) => setRule({ ...rule, qty: num(v, 2, 24) })} keyboardType="number-pad" accessibilityLabel="How many" />
          <Text style={s.body}>for $</Text>
          <TextInput style={s.num} value={(rule.price_cents / 100).toFixed(2)} onChangeText={(v) => setRule({ ...rule, price_cents: money(v) })} keyboardType="decimal-pad" accessibilityLabel="Deal price" />
          <Text style={s.muted}>mix and match any of them · cash price; card follows</Text>
        </View>
      ) : rule.kind === 'buy_get' ? (
        <View style={s.line}>
          <Text style={s.body}>Buy</Text>
          <TextInput style={s.num} value={String(rule.buy)} onChangeText={(v) => setRule({ ...rule, buy: num(v, 1, 12) })} keyboardType="number-pad" accessibilityLabel="Buy" />
          <Text style={s.body}>get</Text>
          <TextInput style={s.num} value={String(rule.get)} onChangeText={(v) => setRule({ ...rule, get: num(v, 1, 12) })} keyboardType="number-pad" accessibilityLabel="Get" />
          <TextInput style={s.num} value={String(rule.percent_off)} onChangeText={(v) => setRule({ ...rule, percent_off: num(v, 1, 100) })} keyboardType="number-pad" accessibilityLabel="Percent off" />
          <Text style={s.body}>% off (100 = free, the cheaper ones)</Text>
        </View>
      ) : (
        <View style={s.line}>
          <TextInput style={s.num} value={String(rule.percent_off)} onChangeText={(v) => setRule({ ...rule, percent_off: num(v, 1, 90) })} keyboardType="number-pad" accessibilityLabel="Percent off" />
          <Text style={s.body}>% off everything that qualifies</Text>
        </View>
      )}
      <Text style={s.label}>Name (shows on the receipt and the customer screen)</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder={parsed.success ? parsed.data.name : 'Energy drinks'} maxLength={48} />

      <Text style={s.label}>What qualifies</Text>
      <View style={s.chips}>
        {catalog.categories.filter((c) => c.active).map((c) => chip(categoryIds.includes(c.category_id), c.name, () => setCategoryIds(categoryIds.includes(c.category_id) ? categoryIds.filter((x) => x !== c.category_id) : [...categoryIds, c.category_id]), c.category_id))}
      </View>
      <TextInput style={s.input} value={search} onChangeText={setSearch} placeholder="…or add items: type a name" />
      <View style={s.chips}>
        {matches.map((i) => chip(itemIds.includes(i.item_id), i.name, () => setItemIds(itemIds.includes(i.item_id) ? itemIds.filter((x) => x !== i.item_id) : [...itemIds, i.item_id]), i.item_id))}
      </View>
      {itemIds.length ? <View style={s.chips}>{itemIds.map((id) => chip(true, `✕ ${itemName(id)}`, () => setItemIds(itemIds.filter((x) => x !== id)), `sel-${id}`))}</View> : null}

      <Text style={s.label}>When</Text>
      <View style={s.line}>
        <TextInput style={s.dateInput} value={startsOn} onChangeText={setStartsOn} placeholder="YYYY-MM-DD" accessibilityLabel="Starts on" />
        <Text style={s.body}>to</Text>
        <TextInput style={s.dateInput} value={endsOn} onChangeText={setEndsOn} placeholder="no end" accessibilityLabel="Ends on" />
      </View>
      <View style={s.chips}>
        {chip(days === null, 'Every day', () => setDays(null))}
        {DAYS.map((d, i) => chip(!!days?.includes(i), d, () => setDays(days?.includes(i) ? (days.length > 1 ? days.filter((x) => x !== i) : null) : [...(days ?? []), i].sort()), d))}
      </View>
      <TextInput style={s.input} value={hours} onChangeText={setHours} placeholder="Hours, e.g. 15:00-18:00 (blank = all day)" autoCapitalize="none" />
      <Pressable onPress={() => setIdle(!idle)} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: idle }}>
        <View style={[s.box, idle && s.boxOn]} />
        <Text style={s.body}>Show it on the customer screen between customers</Text>
      </Pressable>
      {parsed.success ? <Text style={s.preview}>★ {promotionText(parsed.data)}</Text> : null}
      {error || !parsed.success ? <Text style={s.error}>{error ?? parsed.error?.issues[0]?.message}</Text> : null}
      <View style={s.line}>
        <Pressable style={[s.button, { flex: 1 }, (busy || !parsed.success) && { opacity: 0.5 }]} disabled={busy || !parsed.success} onPress={() => void save()}>
          <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save deal'}</Text>
        </Pressable>
        <Pressable style={s.small} onPress={() => onDone(null)}>
          <Text style={s.smallText}>Cancel</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  h2: { fontSize: 18, fontWeight: '800', color: C.ink },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 },
  name: { fontWeight: '800', color: C.ink, fontSize: 16 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginTop: 6 },
  muted: { color: C.muted },
  body: { color: C.ink },
  error: { color: '#8a5300' },
  preview: { fontSize: 16, fontWeight: '800', color: C.green },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 60, fontSize: 16, backgroundColor: '#fff' },
  dateInput: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, width: 130, fontSize: 16, backgroundColor: '#fff' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  check: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: C.muted },
  boxOn: { backgroundColor: C.black, borderColor: C.black },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  small: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, marginTop: 4 },
  smallText: { color: C.ink },
});
