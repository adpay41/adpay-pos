/**
 * Stock (Bible 2.4 stock levels, low stock, dead stock; 1.9 case-break, expiry, write-offs; P22):
 * what's on the shelf at each store, folded from counts, deliveries, write-offs and sales. Nothing
 * here edits a number directly: a count, a delivery or a write-off is recorded, and the level follows.
 */
import { WRITE_OFF_REASONS, type CatalogSnapshot, type WriteOffReason } from '@adpay/shared';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

interface StockRow {
  item_id: string;
  name: string;
  category: string | null;
  on_hand: number;
  reorder_point: number | null;
  low: boolean;
  dead: boolean;
  counted_at: string | null;
  last_sold_at: string | null;
  perishable: boolean;
  packs: { item_id: string; name: string; ratio: number }[];
}
interface Expiring {
  item_id: string;
  name: string;
  expires_on: string;
  qty: number;
}
interface Loc {
  location_id: string;
  name: string;
}

export function StockTab({ token }: { token: string }) {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loc, setLoc] = useState<string | null>(null);
  const [data, setData] = useState<{ items: StockRow[]; expiring: Expiring[] } | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [filter, setFilter] = useState<'all' | 'low' | 'dead'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ locations: Loc[] }>('/merchant/locations', token).then((r) => {
      setLocs(r.locations);
      setLoc((l) => l ?? r.locations[0]?.location_id ?? null);
    }, (e: Error) => setError(e.message));
    api<CatalogSnapshot>('/merchant/catalog', token).then(setCatalog, () => undefined);
  }, [token, nonce]);
  useEffect(() => {
    if (!loc) return;
    api<{ items: StockRow[]; expiring: Expiring[] }>(`/merchant/inventory?location_id=${loc}`, token).then(setData, (e: Error) => setError(e.message));
  }, [token, loc, nonce]);
  const reload = () => setNonce((n) => n + 1);

  const shown = (data?.items ?? []).filter((i) => filter === 'all' || (filter === 'low' ? i.low : i.dead));
  return (
    <ScrollView contentContainerStyle={s.page}>
      {locs.length > 1 ? (
        <View style={s.chips}>
          {locs.map((l) => (
            <Pressable key={l.location_id} onPress={() => setLoc(l.location_id)} style={[s.chip, loc === l.location_id && s.chipOn]}>
              <Text style={[s.chipText, loc === l.location_id && s.chipTextOn]}>{l.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? <ActivityIndicator /> : null}
      {data?.expiring.length ? (
        <View style={[s.card, { borderColor: '#f3d7a8', backgroundColor: '#fff8ec' }]}>
          <Text style={s.label}>Sell soon</Text>
          {data.expiring.map((x, i) => (
            <Text key={i} style={s.warn}>
              {x.name}: up to {x.qty} {x.expires_on <= new Date().toISOString().slice(0, 10) ? 'past its date' : `by ${x.expires_on}`}
            </Text>
          ))}
        </View>
      ) : null}
      {data ? (
        <View style={s.chips}>
          {(['all', 'low', 'dead'] as const).map((f) => (
            <Pressable key={f} onPress={() => setFilter(f)} style={[s.chip, filter === f && s.chipOn]}>
              <Text style={[s.chipText, filter === f && s.chipTextOn]}>
                {f === 'all' ? `All (${data.items.length})` : f === 'low' ? `Low (${data.items.filter((i) => i.low).length})` : `Not selling (${data.items.filter((i) => i.dead).length})`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {data?.items.length === 0 ? <Text style={s.muted}>No items tracked yet. Turn tracking on below for the items you want to count.</Text> : null}
      {shown.map((i) => (
        <Pressable key={i.item_id} style={s.card} onPress={() => setOpen(open === i.item_id ? null : i.item_id)} accessibilityRole="button">
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{i.name}</Text>
              <Text style={s.muted}>
                {i.counted_at ? `counted ${new Date(i.counted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'never counted'}
                {i.dead ? ' · no sale in 60 days' : ''}
                {i.packs.length ? ` · ${i.packs.map((p) => `${p.name} = ${p.ratio}`).join(', ')}` : ''}
              </Text>
            </View>
            <Text style={[s.qty, i.low && s.warn]}>{i.on_hand}</Text>
          </View>
          {i.low ? <Text style={s.warn}>Low: at or below {i.reorder_point}</Text> : null}
          {open === i.item_id && loc ? <Actions token={token} row={i} locationId={loc} onDone={reload} /> : null}
        </Pressable>
      ))}
      {catalog ? <TrackItems token={token} catalog={catalog} onDone={reload} /> : null}
    </ScrollView>
  );
}

function Actions({ token, row, locationId, onDone }: { token: string; row: StockRow; locationId: string; onDone: () => void }) {
  const [kind, setKind] = useState<'count' | 'receive' | 'write_off'>('count');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<WriteOffReason>('damaged');
  const [expires, setExpires] = useState('');
  const [invoice, setInvoice] = useState('');
  const [reorder, setReorder] = useState(row.reorder_point === null ? '' : String(row.reorder_point));
  const [msg, setMsg] = useState<string | null>(null);
  const n = Number.parseInt(qty.replace(/\D/g, '') || '', 10);
  async function save() {
    setMsg(null);
    try {
      const body =
        kind === 'count'
          ? { kind, item_id: row.item_id, location_id: locationId, qty: n }
          : kind === 'receive'
            ? { kind, item_id: row.item_id, location_id: locationId, qty: n, invoice_ref: invoice.trim() || null, expires_on: row.perishable && expires ? expires : null }
            : { kind, item_id: row.item_id, location_id: locationId, qty: n, reason };
      await api('/merchant/inventory/movements', token, body, 'POST');
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function saveReorder() {
    try {
      await api(`/merchant/items/${row.item_id}/stock`, token, { track_stock: true, reorder_point: reorder === '' ? null : Number(reorder), perishable: row.perishable }, 'PUT');
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <View style={s.inner}>
      <View style={s.chips}>
        {([['count', 'Count'], ['receive', 'Received'], ['write_off', 'Write off']] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => setKind(k)} style={[s.chip, kind === k && s.chipOn]}>
            <Text style={[s.chipText, kind === k && s.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.chips}>
        <TextInput style={s.num} value={qty} onChangeText={setQty} keyboardType="number-pad" placeholder={kind === 'count' ? 'on shelf' : 'how many'} accessibilityLabel="Quantity" />
        {kind === 'receive' ? <TextInput style={s.num} value={invoice} onChangeText={setInvoice} placeholder="invoice #" /> : null}
        {kind === 'receive' && row.perishable ? <TextInput style={s.num} value={expires} onChangeText={setExpires} placeholder="expires YYYY-MM-DD" /> : null}
      </View>
      {kind === 'write_off' ? (
        <View style={s.chips}>
          {WRITE_OFF_REASONS.map((r) => (
            <Pressable key={r} onPress={() => setReason(r)} style={[s.chip, reason === r && s.chipOn]}>
              <Text style={[s.chipText, reason === r && s.chipTextOn]}>{r}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Pressable style={[s.button, !(n >= (kind === 'count' ? 0 : 1)) && { opacity: 0.5 }]} disabled={!(n >= (kind === 'count' ? 0 : 1))} onPress={() => void save()}>
        <Text style={s.buttonText}>{kind === 'count' ? `Set to ${Number.isNaN(n) ? '…' : n}` : kind === 'receive' ? 'Add to stock' : 'Write off'}</Text>
      </Pressable>
      <View style={s.chips}>
        <Text style={s.muted}>Low at</Text>
        <TextInput style={s.num} value={reorder} onChangeText={(v) => setReorder(v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="—" accessibilityLabel="Low-stock point" />
        <Pressable style={s.chip} onPress={() => void saveReorder()}>
          <Text style={s.chipText}>Save</Text>
        </Pressable>
      </View>
      {msg ? <Text style={s.error}>{msg}</Text> : null}
    </View>
  );
}

/** Turn tracking on for an item, optionally as a pack of another ("carton = 10 packs"). */
function TrackItems({ token, catalog, onDone }: { token: string; catalog: CatalogSnapshot; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [packOf, setPackOf] = useState<{ item_id: string; name: string } | null>(null);
  const [ratio, setRatio] = useState('10');
  const [perishable, setPerishable] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t.length < 2 ? [] : catalog.items.filter((i) => i.active && !i.open_price && i.name.toLowerCase().includes(t)).slice(0, 8);
  }, [q, catalog]);
  async function track(itemId: string) {
    setMsg(null);
    try {
      await api(`/merchant/items/${itemId}/stock`, token, packOf ? { track_stock: true, stock_of: packOf.item_id, stock_ratio: Number(ratio) || 1 } : { track_stock: true, perishable }, 'PUT');
      setMsg(packOf ? 'Saved as a pack: its sales and deliveries count in the other item.' : 'Tracking on. Count it once to start.');
      setQ('');
      setPackOf(null);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <View style={s.card}>
      <Text style={s.label}>Track an item</Text>
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Type an item name" />
      <View style={s.chips}>
        <Pressable onPress={() => setPerishable(!perishable)} style={[s.chip, perishable && s.chipOn]}>
          <Text style={[s.chipText, perishable && s.chipTextOn]}>Perishable (asks for a date)</Text>
        </Pressable>
        {packOf ? (
          <>
            <Text style={s.muted}>Pack of {packOf.name} ×</Text>
            <TextInput style={s.num} value={ratio} onChangeText={(v) => setRatio(v.replace(/\D/g, ''))} keyboardType="number-pad" accessibilityLabel="Units per pack" />
            <Pressable style={s.chip} onPress={() => setPackOf(null)}>
              <Text style={s.chipText}>Not a pack</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {matches.map((i) => (
        <View key={i.item_id} style={s.row}>
          <Text style={[s.body, { flex: 1 }]}>{i.name}{i.track_stock ? ' · tracked' : ''}</Text>
          <Pressable style={s.chip} onPress={() => void track(i.item_id)}>
            <Text style={s.chipText}>{packOf ? 'Is this pack' : 'Track'}</Text>
          </Pressable>
          {!packOf ? (
            <Pressable style={s.chip} onPress={() => setPackOf({ item_id: i.item_id, name: i.name })}>
              <Text style={s.chipText}>Breaks into…</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <Text style={s.mutedSmall}>For a carton: pick the single pack, tap “Breaks into…”, then find the carton and tap “Is this pack”.</Text>
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, gap: 6 },
  inner: { gap: 8, padding: 10, borderRadius: 8, backgroundColor: C.ground },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontWeight: '700', color: C.ink },
  qty: { fontSize: 22, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  body: { color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  warn: { color: '#8a5300', fontWeight: '700' },
  error: { color: '#8a5300' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 90, fontSize: 16, backgroundColor: '#fff' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
});
