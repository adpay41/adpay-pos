/**
 * P20b in the merchant app: bulk price change (Bible 2.3, "+5% on all drinks"), an item's price
 * history (who changed what), and profit by category (Bible 2.2, "tobacco is 31% of sales and 6% of
 * profit").
 */
import { BulkPriceInput, cents, formatUsd, localDate, marginTenths, parseUsdToCents, type CatalogSnapshot, type MarginLine } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

const usd = (v: number) => formatUsd(cents(v));
const pct = (tenths: number | null) => (tenths === null ? '—' : `${Math.trunc(tenths / 10)}.${Math.abs(tenths % 10)}%`);

interface Preview {
  dry_run: boolean;
  changed: number;
  unchanged: number;
  below_cost: number;
  sample: { item_id: string; name: string; from_cents: number; to_cents: number; cost_cents: number | null }[];
}

export function BulkPrice({ token, catalog, onSaved }: { token: string; catalog: CatalogSnapshot; onSaved: (m: string) => void }) {
  const [cats, setCats] = useState<string[]>([]);
  const [kind, setKind] = useState<'percent' | 'amount' | 'set'>('percent');
  const [value, setValue] = useState('5');
  const [round, setRound] = useState<'none' | 'up_9' | 'up_99'>('none');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "+5" / "-10" percent → ppm with integer math only; dollars through parseUsdToCents.
  const change = (() => {
    try {
      if (kind === 'percent') {
        const m = /^([+-])?(\d{1,3})(?:\.(\d))?$/.exec(value.trim().replace('%', ''));
        if (!m) return null;
        const tenths = Number.parseInt(m[2]!, 10) * 10 + Number.parseInt(m[3] ?? '0', 10);
        return { kind: 'percent' as const, ppm: (m[1] === '-' ? -1 : 1) * tenths * 1_000 };
      }
      const c = parseUsdToCents(value);
      return kind === 'amount' ? { kind: 'amount' as const, cents: c } : { kind: 'set' as const, cents: c };
    } catch {
      return null;
    }
  })();
  const parsed = change ? BulkPriceInput.safeParse({ category_ids: cats, change, round, dry_run: true }) : null;

  async function run(dry: boolean) {
    if (!parsed?.success) return setError(parsed ? (parsed.error.issues[0]?.message ?? 'Check the fields') : 'Type a number, like 5 or -10');
    setBusy(true);
    setError(null);
    try {
      const r = await api<Preview>('/merchant/catalog/bulk-price', token, { ...parsed.data, dry_run: dry }, 'POST');
      if (dry) setPreview(r);
      else {
        setPreview(null);
        onSaved(`${r.changed} prices changed.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.card}>
      <Text style={s.h2}>Change many prices at once</Text>
      <Text style={s.label}>Which categories</Text>
      <View style={s.chips}>
        {catalog.categories.filter((c) => c.active).map((c) => {
          const on = cats.includes(c.category_id);
          return (
            <Pressable key={c.category_id} onPress={() => { setCats(on ? cats.filter((x) => x !== c.category_id) : [...cats, c.category_id]); setPreview(null); }} style={[s.chip, on && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
              <Text style={[s.chipText, on && s.chipTextOn]}>{c.name}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={s.chips}>
        {([['percent', '± %'], ['amount', '± $'], ['set', 'Set to $']] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => { setKind(k); setPreview(null); }} style={[s.chip, kind === k && s.chipOn]}>
            <Text style={[s.chipText, kind === k && s.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
        <TextInput style={s.num} value={value} onChangeText={(v) => { setValue(v); setPreview(null); }} keyboardType="numbers-and-punctuation" accessibilityLabel="Change" placeholder={kind === 'percent' ? '5 or -10' : '0.25'} />
      </View>
      <View style={s.chips}>
        {([['none', 'Exact'], ['up_9', 'Round up to …9'], ['up_99', 'Round up to .99']] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => { setRound(k); setPreview(null); }} style={[s.chip, round === k && s.chipOn]}>
            <Text style={[s.chipText, round === k && s.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {preview ? (
        <View style={{ gap: 4 }}>
          <Text style={s.body}>
            {preview.changed} prices change{preview.unchanged ? `, ${preview.unchanged} stay the same` : ''}.
          </Text>
          {preview.below_cost ? <Text style={s.warn}>{preview.below_cost} would be below your cost.</Text> : null}
          {preview.sample.slice(0, 12).map((x) => (
            <Text key={x.item_id} style={x.cost_cents !== null && x.to_cents < x.cost_cents ? s.warn : s.muted}>
              {x.name}: {usd(x.from_cents)} → {usd(x.to_cents)}
            </Text>
          ))}
          <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void run(false)}>
            <Text style={s.buttonText}>Change {preview.changed} prices</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={[s.buttonGhost, (busy || !parsed?.success) && { opacity: 0.5 }]} disabled={busy || !parsed?.success} onPress={() => void run(true)}>
          <Text style={s.buttonGhostText}>Preview</Text>
        </Pressable>
      )}
      <Text style={s.mutedSmall}>Card prices follow automatically. Every change is kept in each item's price history.</Text>
    </View>
  );
}

interface HistoryRow {
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  changed_at: string;
  changed_by_name: string | null;
}

export function PriceHistory({ token, itemId }: { token: string; itemId: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  useEffect(() => {
    api<{ history: HistoryRow[] }>(`/merchant/items/${itemId}/history`, token).then((r) => setRows(r.history), () => setRows([]));
  }, [token, itemId]);
  if (!rows?.length) return null;
  return (
    <View style={s.card}>
      <Text style={s.label}>Price history</Text>
      {rows.slice(0, 20).map((r, i) => (
        <Text key={i} style={s.muted}>
          {new Date(r.changed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {usd(r.cash_price_cents)}
          {r.card_price_cents !== null ? ` (card ${usd(r.card_price_cents)})` : ''}
          {r.cost_cents !== null ? ` · cost ${usd(r.cost_cents)}` : ''} · {r.changed_by_name ?? 'import'}
        </Text>
      ))}
    </View>
  );
}

interface Profit {
  total: MarginLine;
  categories: MarginLine[];
  items: MarginLine[];
  below_cost_items: { name: string; units: number }[];
}

/** Profit for the Sales tab's range, by category. */
export function ProfitCard({ token, range }: { token: string; range: 'today' | 'week' | 'month' }) {
  const [data, setData] = useState<Profit | null>(null);
  useEffect(() => {
    const today = localDate(new Date(), 'America/New_York');
    const d = new Date(`${today}T12:00:00Z`);
    const from = range === 'today' ? today : range === 'week' ? new Date(d.getTime() - 6 * 86_400_000).toISOString().slice(0, 10) : `${today.slice(0, 8)}01`;
    let live = true;
    api<Profit>(`/merchant/reports/profit?from=${from}&to=${today}`, token).then((r) => live && setData(r), () => undefined);
    return () => {
      live = false;
    };
  }, [token, range]);
  if (!data || data.total.units === 0) return null;
  const profit = (m: MarginLine) => m.costed_revenue_cents - m.cost_cents;
  const totalProfit = profit(data.total);
  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '—');
  return (
    <View style={s.card}>
      <Text style={s.label}>Profit</Text>
      <View style={s.rowBetween}>
        <Text style={s.big}>{usd(totalProfit)}</Text>
        <Text style={s.muted}>margin {pct(marginTenths(data.total))}</Text>
      </View>
      {data.total.units_without_cost ? (
        <Text style={s.mutedSmall}>
          {data.total.units_without_cost} of {data.total.units} units have no cost entered and aren't counted in profit. Add costs in Items.
        </Text>
      ) : null}
      {data.categories.map((c) => (
        <View key={c.key} style={s.rowBetween}>
          <Text style={[s.body, { flex: 1 }]}>{c.name}</Text>
          <Text style={s.muted}>
            {share(c.revenue_cents, data.total.revenue_cents)} of sales · {share(profit(c), totalProfit)} of profit · {pct(marginTenths(c))}
          </Text>
        </View>
      ))}
      {data.below_cost_items.length ? (
        <Text style={s.warn}>Sold below cost: {data.below_cost_items.slice(0, 5).map((i) => `${i.name} (${i.units})`).join(', ')}</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  h2: { fontSize: 17, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  big: { fontSize: 26, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
  body: { color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  warn: { color: '#8a5300', fontWeight: '600' },
  error: { color: '#8a5300' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 80, fontSize: 16, backgroundColor: '#fff' },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  buttonGhost: { borderWidth: 1, borderColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonGhostText: { color: C.ink, fontWeight: '700' },
});
