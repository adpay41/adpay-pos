/**
 * Ordering (Bible 2.4; P23): vendors with their delivery days, what to order from each now (from the
 * last four weeks' sales by weekday, the shelf, and what's already on order), one-tap send to the rep
 * by text or email, and each order's "what came vs what was ordered".
 */
import { VendorInput, type CatalogSnapshot } from '@adpay/shared';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
interface Vendor {
  vendor_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  order_via: 'sms' | 'email';
  delivery_days: number[];
  items: number;
}
interface Suggestion {
  item_id: string;
  name: string;
  on_hand: number;
  on_order: number;
  forecast: number;
  qty: number;
  until: string;
  case_qty: number;
}
interface Order {
  po_id: string;
  vendor: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  send_status: string | null;
  lines: { item_id: string; name: string; ordered: number; received: number }[];
  discrepancies: number;
}

export function OrdersTab({ token }: { token: string }) {
  const [loc, setLoc] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [reorder, setReorder] = useState<{ vendors: { vendor_id: string; name: string; suggestions: Suggestion[] }[] } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  useEffect(() => {
    api<{ locations: { location_id: string }[] }>('/merchant/locations', token).then((r) => setLoc((l) => l ?? r.locations[0]?.location_id ?? null), () => undefined);
    api<{ vendors: Vendor[] }>('/merchant/vendors', token).then((r) => setVendors(r.vendors), (e: Error) => setMsg(e.message));
    api<{ orders: Order[] }>('/merchant/purchase-orders', token).then((r) => setOrders(r.orders), () => undefined);
    api<CatalogSnapshot>('/merchant/catalog', token).then(setCatalog, () => undefined);
  }, [token, nonce]);
  useEffect(() => {
    if (loc) api<{ vendors: { vendor_id: string; name: string; suggestions: Suggestion[] }[] }>(`/merchant/reorder?location_id=${loc}`, token).then(setReorder, () => undefined);
  }, [token, loc, nonce]);

  async function act(poId: string, action: 'send' | 'received' | 'cancel') {
    setMsg(null);
    try {
      const r = await api<{ delivered?: boolean; to?: string }>(`/merchant/purchase-orders/${poId}/${action}`, token, {}, 'POST');
      if (action === 'send') setMsg(r.delivered ? `Sent to ${r.to}.` : `Recorded for ${r.to}, but not delivered: texting and email aren't connected yet. Call or text the rep the order.`);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (!vendors) return <ActivityIndicator style={{ marginTop: 24 }} />;
  return (
    <ScrollView contentContainerStyle={s.page}>
      {msg ? <Text style={s.note}>{msg}</Text> : null}
      {reorder?.vendors.filter((v) => v.suggestions.some((x) => x.qty > 0)).map((v) =>
        loc ? <Suggestions key={v.vendor_id} token={token} vendorId={v.vendor_id} name={v.name} rows={v.suggestions} locationId={loc} onDone={(m) => { setMsg(m); reload(); }} /> : null,
      )}
      {orders.length ? <Text style={s.label}>Orders</Text> : null}
      {orders.map((o) => (
        <View key={o.po_id} style={s.card}>
          <View style={s.row}>
            <Text style={[s.name, { flex: 1 }]}>{o.vendor}</Text>
            <Text style={s.muted}>{o.status}{o.send_status === 'logged' ? ' (not delivered)' : ''}</Text>
          </View>
          {o.lines.map((l) => (
            <Text key={l.item_id} style={o.status !== 'draft' && l.received !== l.ordered && (l.received > 0 || o.status === 'received') ? s.warn : s.muted}>
              {l.name}: ordered {l.ordered}
              {o.status !== 'draft' ? ` · received ${l.received}` : ''}
            </Text>
          ))}
          <View style={s.chips}>
            {o.status === 'draft' ? (
              <Pressable style={s.button} onPress={() => void act(o.po_id, 'send')}>
                <Text style={s.buttonText}>Send to the rep</Text>
              </Pressable>
            ) : null}
            {o.status === 'sent' ? (
              <Pressable style={s.chip} onPress={() => void act(o.po_id, 'received')}>
                <Text style={s.chipText}>Mark received</Text>
              </Pressable>
            ) : null}
            {o.status === 'draft' || o.status === 'sent' ? (
              <Pressable style={s.chip} onPress={() => void act(o.po_id, 'cancel')}>
                <Text style={s.chipText}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}

      <Text style={s.label}>Vendors</Text>
      {vendors.map((v) => (
        <View key={v.vendor_id} style={s.card}>
          <Text style={s.name}>{v.name}</Text>
          <Text style={s.muted}>
            {v.order_via === 'sms' ? v.phone : v.email} · delivers {v.delivery_days.length ? v.delivery_days.map((d) => DAYS[d]).join(' ') : '—'} · {v.items} items
          </Text>
          {catalog ? <AssignItems token={token} vendorId={v.vendor_id} catalog={catalog} onDone={reload} /> : null}
        </View>
      ))}
      {adding ? <VendorEditor token={token} onDone={() => { setAdding(false); reload(); }} /> : (
        <Pressable style={s.button} onPress={() => setAdding(true)}>
          <Text style={s.buttonText}>Add a vendor</Text>
        </Pressable>
      )}
      <Text style={s.mutedSmall}>Suggestions cover sales until the delivery after next, by weekday (weekends included), plus each item's low-stock point, less what's on the shelf and on order, in whole cases.</Text>
    </ScrollView>
  );
}

function Suggestions({ token, vendorId, name, rows, locationId, onDone }: { token: string; vendorId: string; name: string; rows: Suggestion[]; locationId: string; onDone: (m: string) => void }) {
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.item_id, String(r.qty)])));
  const lines = rows.map((r) => ({ item_id: r.item_id, qty: Number.parseInt(qty[r.item_id] || '0', 10) || 0 })).filter((l) => l.qty > 0);
  async function create() {
    try {
      await api('/merchant/purchase-orders', token, { vendor_id: vendorId, location_id: locationId, lines }, 'POST');
      onDone(`Order for ${name} saved as a draft. Check it below, then send it.`);
    } catch (e) {
      onDone((e as Error).message);
    }
  }
  return (
    <View style={s.card}>
      <Text style={s.name}>Order from {name}</Text>
      {rows.map((r) => (
        <View key={r.item_id} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.body}>{r.name}</Text>
            <Text style={s.mutedSmall}>
              {r.on_hand} on the shelf{r.on_order ? ` · ${r.on_order} on order` : ''} · sells ~{r.forecast} by {r.until}
              {r.case_qty > 1 ? ` · case of ${r.case_qty}` : ''}
            </Text>
          </View>
          <TextInput style={s.num} value={qty[r.item_id]} onChangeText={(v) => setQty({ ...qty, [r.item_id]: v.replace(/\D/g, '') })} keyboardType="number-pad" accessibilityLabel={`Order ${r.name}`} />
        </View>
      ))}
      <Pressable style={[s.button, !lines.length && { opacity: 0.5 }]} disabled={!lines.length} onPress={() => void create()}>
        <Text style={s.buttonText}>Make the order ({lines.length} items)</Text>
      </Pressable>
    </View>
  );
}

function VendorEditor({ token, onDone }: { token: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [via, setVia] = useState<'sms' | 'email'>('sms');
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parsed = VendorInput.safeParse({ name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, order_via: via, delivery_days: days });
  return (
    <View style={s.card}>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Vendor, e.g. Coca-Cola" />
      <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Rep's mobile" keyboardType="phone-pad" />
      <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="Rep's email" autoCapitalize="none" keyboardType="email-address" />
      <View style={s.chips}>
        {(['sms', 'email'] as const).map((v) => (
          <Pressable key={v} onPress={() => setVia(v)} style={[s.chip, via === v && s.chipOn]}>
            <Text style={[s.chipText, via === v && s.chipTextOn]}>Orders by {v === 'sms' ? 'text' : 'email'}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.chips}>
        <Text style={s.muted}>Delivers</Text>
        {DAYS.map((d, i) => (
          <Pressable key={d} onPress={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())} style={[s.chip, days.includes(i) && s.chipOn]}>
            <Text style={[s.chipText, days.includes(i) && s.chipTextOn]}>{d}</Text>
          </Pressable>
        ))}
      </View>
      {error || !parsed.success ? <Text style={s.warn}>{error ?? parsed.error?.issues[0]?.message}</Text> : null}
      <Pressable
        style={[s.button, !parsed.success && { opacity: 0.5 }]}
        disabled={!parsed.success}
        onPress={() => void api('/merchant/vendors', token, parsed.data, 'POST').then(onDone, (e: Error) => setError(e.message))}
      >
        <Text style={s.buttonText}>Save vendor</Text>
      </Pressable>
    </View>
  );
}

function AssignItems({ token, vendorId, catalog, onDone }: { token: string; vendorId: string; catalog: CatalogSnapshot; onDone: () => void }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t.length < 2 ? [] : catalog.items.filter((i) => i.active && i.name.toLowerCase().includes(t)).slice(0, 6);
  }, [q, catalog]);
  return (
    <View style={{ gap: 6 }}>
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Add items this vendor supplies" />
      {hits.map((i) => (
        <Pressable key={i.item_id} style={s.chip} onPress={() => void api('/merchant/vendors/items', token, { vendor_id: vendorId, item_ids: [i.item_id] }, 'PUT').then(() => { setQ(''); onDone(); })}>
          <Text style={s.chipText}>+ {i.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginTop: 6 },
  body: { color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  note: { color: C.ink, backgroundColor: C.ground, padding: 10, borderRadius: 8 },
  warn: { color: '#8a5300', fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, width: 72, fontSize: 16, backgroundColor: '#fff', textAlign: 'right' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
});
