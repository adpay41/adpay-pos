/**
 * Cash from the phone (build plan P6, Bible 1.2 / 2.4): every drawer session with its float, drops,
 * paid-outs and blind count; over/short by cashier and by day. Short is amber, over is black: never
 * red near an amount.
 */
import { CASH_MOVEMENT_KINDS, DENOMINATIONS, type CashReport } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { API_URL, api } from './api';
import { C, usd } from './theme';
import { ZReports } from './zreports';

const AMBER = '#8a5300';

function signed(c: number) {
  return c === 0 ? 'even' : c < 0 ? `short ${usd(-c)}` : `over ${usd(c)}`;
}

export function CashTab({ token }: { token: string }) {
  const [range, setRange] = useState<CashReport['range']>('today');
  const [data, setData] = useState<CashReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    api<CashReport>(`/merchant/cash?range=${range}`, token).then(
      (d) => live && setData(d),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [range, token]);

  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.segment}>
        {(['today', 'week', 'month'] as const).map((r) => (
          <Pressable key={r} onPress={() => setRange(r)} style={[s.segItem, range === r && s.segOn]}>
            <Text style={[s.segText, range === r && { color: '#fff' }]}>{r === 'today' ? 'Today' : r === 'week' ? '7 days' : 'Month'}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <>
          {data.open_now?.length ? (
            // Cash in each drawer right now (P15, Bible 2.1), with "drop needed" over the store's threshold.
            <View style={s.card}>
              <Text style={s.label}>In the drawers now</Text>
              {data.open_now.map((d) => (
                <View key={d.session_id} style={s.line}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>
                      {d.register_name} · {d.location_name}
                    </Text>
                    <Text style={s.muted}>
                      open since {new Date(d.opened_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                      {d.drop_needed ? ` · drop needed (about ${usd(d.suggest_cents)})` : ''}
                    </Text>
                  </View>
                  <Text style={[s.money, d.drop_needed && { color: AMBER }]}>{usd(d.expected_cents)}</Text>
                </View>
              ))}
              <Text style={s.muted}>Asks for a drop over {usd(data.drop_over_cents)}; change it under Alerts → Alert settings.</Text>
            </View>
          ) : null}
          <View style={s.card}>
            <Text style={s.label}>Over / short</Text>
            <Text style={[s.big, data.totals.over_short_cents < 0 && { color: AMBER }]}>{signed(data.totals.over_short_cents)}</Text>
            <Text style={s.muted}>
              Drops {usd(data.totals.drops_cents)} · paid out {usd(data.totals.paid_out_cents)} · paid in {usd(data.totals.paid_in_cents)} · {data.totals.no_sale_opens} no-sale opens{data.totals.counterfeits ? ` · ${data.totals.counterfeits} counterfeit bills refused` : ''}
            </Text>
          </View>

          {data.by_cashier.length ? (
            <View style={s.card}>
              <Text style={s.label}>By cashier</Text>
              {data.by_cashier.map((c) => (
                <View key={c.user_id ?? 'none'} style={s.line}>
                  <Text style={s.name}>{c.name ?? 'Not signed in'}</Text>
                  <Text style={s.muted}>{c.sessions} counts</Text>
                  <Text style={[s.money, c.over_short_cents < 0 && { color: AMBER }]}>{signed(c.over_short_cents)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {data.by_day.length > 1 ? (
            <View style={s.card}>
              <Text style={s.label}>By day</Text>
              {data.by_day.map((d) => (
                <View key={d.date} style={s.line}>
                  <Text style={s.name}>{new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
                  <Text style={[s.money, d.over_short_cents < 0 && { color: AMBER }]}>{signed(d.over_short_cents)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <ZReports token={token} from={data.from} to={data.to} />

          <Text style={s.label}>Drawer sessions</Text>
          {data.sessions.length === 0 ? <Text style={s.muted}>No drawers counted in this period.</Text> : null}
          {data.sessions.map((d) => (
            <Pressable key={d.session_id} style={s.card} onPress={() => setOpen(open === d.session_id ? null : d.session_id)}>
              <View style={s.line}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>
                    {d.register_name} · {new Date(d.opened_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                  </Text>
                  <Text style={s.muted}>
                    {d.opened_by_name ?? 'someone'} · float {usd(d.float_cents)} · {d.cash_sale_count} cash sales
                  </Text>
                </View>
                {d.over_short_cents === null ? (
                  <Text style={s.muted}>open</Text>
                ) : (
                  <Text style={[s.money, d.over_short_cents < 0 && { color: AMBER }]}>{signed(d.over_short_cents)}</Text>
                )}
              </View>
              {open === d.session_id ? (
                <View style={{ marginTop: 8, gap: 2 }}>
                  <Text style={s.muted}>Cash sales {usd(d.cash_sales_cents)} · refunds {usd(d.cash_refunds_cents)}</Text>
                  {d.movements.map((m) => (
                    <Text key={m.movement_id} style={s.muted}>
                      {CASH_MOVEMENT_KINDS[m.kind].label} {usd(m.amount_cents)} — {m.reason}
                    </Text>
                  ))}
                  <Text style={s.muted}>
                    Should hold {usd(d.expected_cents)}
                    {d.counted_cents !== null ? ` · counted ${usd(d.counted_cents)} by ${d.closed_by_name ?? 'someone'}` : ''}
                    {d.handover ? ' · handed over' : ''}
                  </Text>
                  {d.denominations ? (
                    <Text style={s.muted}>
                      {DENOMINATIONS.filter((x) => (d.denominations![String(x.cents)] ?? 0) > 0)
                        .map((x) => `${d.denominations![String(x.cents)]} × ${x.label}`)
                        .join(' · ')}
                    </Text>
                  ) : null}
                  {d.photo_media_id ? (
                    <Image source={{ uri: `${API_URL}/media/${d.photo_media_id}` }} style={{ width: 160, height: 120, borderRadius: 6, marginTop: 4 }} accessibilityLabel="Photo of the count sheet" />
                  ) : null}
                  {d.counterfeits.map((c, i) => (
                    <Text key={i} style={s.muted}>
                      Refused a counterfeit {usd(c.denomination_cents)} at {new Date(c.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      {c.note ? ` — ${c.note}` : ''}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10, maxWidth: 640, width: '100%', alignSelf: 'center' },
  segment: { flexDirection: 'row', backgroundColor: '#e9e9e9', borderRadius: 8, padding: 3 },
  segItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segOn: { backgroundColor: C.black },
  segText: { fontWeight: '600', color: C.ink },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  big: { fontSize: 30, fontWeight: '800', color: C.black },
  muted: { color: C.muted },
  error: { color: C.red },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  name: { color: C.ink, fontWeight: '600', flexShrink: 1 },
  money: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'], marginLeft: 'auto' },
});
