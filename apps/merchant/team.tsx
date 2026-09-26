/**
 * P19b in the merchant app: the multi-store roll-up (Bible 2.1: owners with 2–5 stores) on the Sales
 * tab, and cashier performance (Bible 2.5) on the Hours tab. Both read what the API folds from events.
 */
import { cents, formatUsd, hhmm } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

const usd = (v: number) => formatUsd(cents(v));
const change = (now: number, prev: number) => (prev ? `${now >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((now - prev) * 100) / prev))}%` : '');

interface RollupRow {
  merchant_id: string;
  merchant_name: string;
  location_id: string;
  location_name: string;
  tickets: number;
  gross_cents: number;
  avg_ticket_cents: number | null;
  card_tickets: number;
  prev_gross_cents: number;
}

/** Every store this person sees reports for; shown only when there is more than one. */
export function RollupCard({ token, range }: { token: string; range: 'today' | 'week' | 'month' }) {
  const [data, setData] = useState<{ stores: RollupRow[]; total: { tickets: number; gross_cents: number; prev_gross_cents: number } } | null>(null);
  useEffect(() => {
    let live = true;
    api<{ stores: RollupRow[]; total: { tickets: number; gross_cents: number; prev_gross_cents: number } }>(`/merchant/rollup?range=${range}`, token).then(
      (d) => live && setData(d),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [token, range]);
  if (!data || data.stores.length < 2) return null;
  const prevLabel = range === 'today' ? 'yesterday' : range === 'week' ? 'the 7 days before' : 'the same days before';
  return (
    <View style={s.card}>
      <Text style={s.label}>All your stores</Text>
      <View style={s.line}>
        <Text style={s.big}>{usd(data.total.gross_cents)}</Text>
        <Text style={s.muted}>
          {data.total.tickets} tickets {change(data.total.gross_cents, data.total.prev_gross_cents)}
        </Text>
      </View>
      {data.stores.map((st) => (
        <View key={st.location_id} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{st.merchant_name}</Text>
            <Text style={s.muted}>
              {st.location_name} · {st.tickets} tickets{st.avg_ticket_cents !== null ? ` · avg ${usd(st.avg_ticket_cents)}` : ''}
              {st.tickets ? ` · ${Math.round((st.card_tickets * 100) / st.tickets)}% card` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.money}>{usd(st.gross_cents)}</Text>
            <Text style={s.mutedSmall}>{change(st.gross_cents, st.prev_gross_cents)}</Text>
          </View>
        </View>
      ))}
      <Text style={s.mutedSmall}>Arrows compare with {prevLabel}. Tap a store name at the top to switch to it.</Text>
    </View>
  );
}

interface Perf {
  user_id: string;
  name: string;
  sales: number;
  gross_cents: number;
  avg_ticket_cents: number | null;
  minutes_on_clock: number;
  per_hour_cents: number | null;
  voids: number;
  refunds: number;
  refund_cents: number;
  no_sale_opens: number;
  drawer_counts: number;
  over_short_cents: number | null;
  age_checks: number;
  id_scans: number;
  age_checks_missed: number;
}

export function CashierPerformance({ token, from, to }: { token: string; from: string; to: string }) {
  const [rows, setRows] = useState<Perf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    api<{ cashiers: Perf[] }>(`/merchant/reports/cashiers?from=${from}&to=${to}`, token).then(
      (d) => live && setRows(d.cashiers),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [token, from, to]);
  return (
    <View style={s.card}>
      <Text style={s.label}>Cashier performance</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {rows?.length === 0 ? <Text style={s.muted}>No sales by signed-in cashiers in these days.</Text> : null}
      {rows?.map((p) => (
        <View key={p.user_id} style={s.perf}>
          <View style={s.line}>
            <Text style={s.name}>{p.name}</Text>
            <Text style={s.money}>{usd(p.gross_cents)}</Text>
          </View>
          <Text style={s.muted}>
            {p.sales} sales{p.avg_ticket_cents !== null ? ` · avg ${usd(p.avg_ticket_cents)}` : ''}
            {p.minutes_on_clock ? ` · ${hhmm(p.minutes_on_clock)} on the clock` : ''}
            {p.per_hour_cents !== null ? ` · ${usd(p.per_hour_cents)}/hour` : ''}
          </Text>
          <Text style={s.muted}>
            {p.voids} voids · {p.refunds} refunds{p.refunds ? ` (${usd(p.refund_cents)})` : ''} · {p.no_sale_opens} “no sale” opens
            {p.over_short_cents !== null ? ` · drawer ${p.over_short_cents === 0 ? 'exact' : p.over_short_cents > 0 ? `over ${usd(p.over_short_cents)}` : `short ${usd(-p.over_short_cents)}`} (${p.drawer_counts} counts)` : ''}
          </Text>
          <Text style={p.age_checks_missed ? s.warn : s.muted}>
            {p.age_checks} age checks ({p.id_scans} by ID scan){p.age_checks_missed ? ` · ${p.age_checks_missed} age-restricted sold without a check` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 6 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  big: { fontSize: 26, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line },
  perf: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line, gap: 2 },
  name: { fontWeight: '700', color: C.ink },
  money: { fontWeight: '700', color: C.ink, fontVariant: ['tabular-nums'] },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  warn: { color: '#8a5300', fontWeight: '600' },
  error: { color: '#8a5300' },
});
