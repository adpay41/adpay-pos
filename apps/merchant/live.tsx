/**
 * Live view for the owner (build plan P11, Bible 2.1 L30/L31):
 *   - a sales ticker per register and cashier, fed by the API's `/ws` channel (P4), seeded from the
 *     latest tickets so it isn't empty on open;
 *   - today vs yesterday vs the same day last week, cut at the same time of day ("up 12%").
 * The socket is a fast path: if it can't connect, the numbers still load and refresh on pull.
 */
import { pctChangeText, type SaleListRow, type SalesCompare, type ServerMessage } from '@adpay/shared';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { API_URL } from './api';
import { C, usd } from './theme';

/** Subscribe to this merchant's live messages. Authenticates with the first message, never the URL. */
export function useRealtime(token: string, onMessage: (m: ServerMessage) => void): boolean {
  const handler = useRef(onMessage);
  const [live, setLive] = useState(false);
  useEffect(() => {
    handler.current = onMessage;
  });
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as ServerMessage;
          if (m.type === 'ready') {
            backoff = 1_000;
            setLive(true);
          }
          handler.current(m);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setLive(false);
        if (stopped) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(30_000, backoff * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [token]);
  return live;
}

export interface TickerRow {
  sale_id: string;
  at: string;
  register_name: string;
  cashier_name: string | null;
  total_cents: number;
  price_mode: 'cash' | 'card' | 'split' | null;
  fresh?: boolean;
}

export const tickerFromList = (sales: SaleListRow[]): TickerRow[] =>
  sales
    .filter((x) => x.status === 'completed')
    .map((x) => ({ sale_id: x.sale_id, at: x.occurred_at, register_name: `${x.register_name} · ${x.location_name}`, cashier_name: x.cashier_name, total_cents: x.total_cents, price_mode: x.price_mode }));

export const tickerFromMessage = (m: Extract<ServerMessage, { type: 'sale' }>): TickerRow => ({
  sale_id: m.sale_id,
  at: m.at,
  register_name: m.register_name ?? 'Register',
  cashier_name: m.cashier_name ?? null,
  total_cents: m.total_cents,
  price_mode: m.price_mode,
  fresh: true,
});

const time = (at: string) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function LiveTicker({ rows, live }: { rows: TickerRow[]; live: boolean }) {
  return (
    <View style={s.card}>
      <View style={s.head}>
        <Text style={s.label}>Live</Text>
        <Text style={s.mutedSmall}>{live ? '● connected' : 'reconnecting…'}</Text>
      </View>
      {rows.length === 0 ? <Text style={s.muted}>No sales yet today.</Text> : null}
      {rows.slice(0, 12).map((r) => (
        <View key={r.sale_id} style={[s.line, r.fresh && s.fresh]}>
          <View style={{ flex: 1 }}>
            <Text style={s.lineName}>
              {time(r.at)} · {r.register_name}
            </Text>
            <Text style={s.mutedSmall}>
              {r.cashier_name ?? 'No one signed in'}
              {r.price_mode ? ` · ${r.price_mode}` : ''}
            </Text>
          </View>
          <Text style={s.money}>{usd(r.total_cents)}</Text>
        </View>
      ))}
    </View>
  );
}

const DAY_LABEL = { today: 'Today', yesterday: 'Yesterday', last_week: 'Same day last week' } as const;

export function CompareCard({ data }: { data: SalesCompare }) {
  const [today, yesterday, lastWeek] = data.days;
  const asOf = new Date(2000, 0, 1, data.as_of.hour, data.as_of.minute).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const max = Math.max(1, ...data.days.flatMap((d) => d.by_hour.map((h) => h.amount_cents)));
  const hours = Array.from({ length: 18 }, (_, i) => i + 5);
  const vs = (tenths: number | null, label: string) => {
    const text = pctChangeText(tenths);
    // Up is money in (green); down stays ink — never red near an amount.
    return text ? <Text style={[s.vs, tenths! > 0 && { color: C.green }]}>{`${text} vs ${label}`}</Text> : <Text style={s.mutedSmall}>{`nothing to compare with ${label}`}</Text>;
  };
  return (
    <View style={s.card}>
      <Text style={s.label}>Today so far · by {asOf}</Text>
      <Text style={s.big}>{usd(today!.so_far_cents)}</Text>
      {vs(data.vs_yesterday_tenths, 'yesterday')}
      {vs(data.vs_last_week_tenths, 'last week')}
      <View style={s.bars}>
        {hours.map((h) => {
          const v = (d: (typeof data.days)[number]) => d.by_hour.find((x) => x.hour === h)?.amount_cents ?? 0;
          return (
            <View key={h} style={s.barGroup}>
              <View style={[s.bar, s.barWeek, { height: `${Math.max(2, Math.round((v(lastWeek!) * 100) / max))}%` }]} />
              <View style={[s.bar, s.barYest, { height: `${Math.max(2, Math.round((v(yesterday!) * 100) / max))}%` }]} />
              <View style={[s.bar, { height: `${Math.max(2, Math.round((v(today!) * 100) / max))}%` }, h > data.as_of.hour && { opacity: 0 }]} />
            </View>
          );
        })}
      </View>
      <View style={s.legend}>
        {data.days.map((d) => (
          <Text key={d.key} style={s.mutedSmall}>
            <Text style={d.key === 'today' ? s.keyToday : d.key === 'yesterday' ? s.keyYest : s.keyWeek}>■ </Text>
            {DAY_LABEL[d.key]} {usd(d.total_cents)}
          </Text>
        ))}
      </View>
    </View>
  );
}

export function CashierCard({ rows }: { rows: { user_id: string | null; name: string; amount_cents: number; count: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <View style={s.card}>
      <Text style={s.label}>By cashier</Text>
      {rows.map((r) => (
        <View key={r.user_id ?? 'none'} style={s.line}>
          <View style={{ flex: 1 }}>
            <Text style={s.lineName}>{r.name}</Text>
            <Text style={s.mutedSmall}>
              {r.count} tickets · avg {usd(r.count ? Math.round(r.amount_cents / r.count) : 0)}
            </Text>
          </View>
          <Text style={s.money}>{usd(r.amount_cents)}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  big: { fontSize: 30, fontWeight: '800', color: C.ink },
  vs: { color: C.ink, fontWeight: '600' },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  fresh: { backgroundColor: '#f1f8f4' },
  lineName: { color: C.ink, fontWeight: '600' },
  money: { color: C.ink, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 90, gap: 3, marginTop: 10 },
  barGroup: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  bar: { flex: 1, backgroundColor: C.black, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  barYest: { backgroundColor: '#9a9a9a' },
  barWeek: { backgroundColor: '#d4d4d4' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  keyToday: { color: C.black },
  keyYest: { color: '#9a9a9a' },
  keyWeek: { color: '#d4d4d4' },
});
