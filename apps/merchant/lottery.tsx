/**
 * Lottery (build plan P17, Bible 1.4; ADR 0027): the day's reconciliation, the bin count, the state
 * terminal's report, packs (receive → activate into a bin → sold out) and games. Amounts are typed
 * as dollars and parsed to cents; differences show amber, never red.
 */
import { localDate, parseUsdToCents, type LotteryDay, type LotteryGame, type LotteryPack } from '@adpay/shared';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, apiText } from './api';
import { C, usd } from './theme';

const AMBER = '#a15c00';
const day = (offset: number) => {
  const t = new Date(`${localDate(new Date(), 'America/New_York')}T12:00:00Z`);
  return new Date(t.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
};

export function LotteryTab({ token }: { token: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [state, setState] = useState<{ games: LotteryGame[]; packs: LotteryPack[] } | null>(null);
  const [date, setDate] = useState(day(0));
  const [rec, setRec] = useState<LotteryDay | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ locations: { location_id: string }[] }>('/merchant/locations', token).then((r) => setLocationId(r.locations[0]?.location_id ?? null), (e) => setMsg((e as Error).message));
  }, [token]);
  const base = locationId ? `/merchant/locations/${locationId}/lottery` : null;
  const load = useCallback(async () => {
    if (!base) return;
    try {
      const [s, d] = await Promise.all([api<{ games: LotteryGame[]; packs: LotteryPack[] }>(base, token), api<LotteryDay>(`${base}/day?date=${date}`, token)]);
      setState(s);
      setRec(d);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, [base, date, token]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  if (!state || !base) return msg ? <Text style={[s.error, { padding: 16 }]}>{msg}</Text> : <ActivityIndicator style={{ marginTop: 24 }} />;
  const active = state.packs.filter((p) => p.status === 'active');
  const received = state.packs.filter((p) => p.status === 'received');

  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.row}>
        {[0, 1].map((o) => (
          <Pressable key={o} onPress={() => setDate(day(o))} style={[s.chip, date === day(o) && s.chipOn]}>
            <Text style={date === day(o) ? { color: '#fff' } : { color: C.ink }}>{o === 0 ? 'Today' : 'Yesterday'}</Text>
          </Pressable>
        ))}
      </View>
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
      {rec ? <Reconciliation d={rec} /> : null}
      <CountCard active={active} date={date} onSave={(entries) => act(() => api(`${base}/counts`, token, { business_date: date, entries }), 'Count saved.')} />
      <TerminalCard
        d={rec}
        onSave={(online, cashes) => act(() => api(`${base}/terminal`, token, { business_date: date, online_sales_cents: online, cashes_cents: cashes }, 'PUT'), 'Terminal report saved.')}
      />
      <PacksCard
        received={received}
        active={active}
        games={state.games}
        onReceive={(game_id, pack_number) => act(() => api(`${base}/packs`, token, { game_id, pack_number }), `Pack ${pack_number} received.`)}
        onActivate={(id, bin) => act(() => api(`/merchant/lottery/packs/${id}/activate`, token, { bin }), `Activated in bin ${bin}.`)}
        onClose={(id, to) => act(() => api(`/merchant/lottery/packs/${id}/${to}`, token, {}), to === 'sold_out' ? 'Marked sold out.' : 'Marked returned.')}
      />
      <Pressable
        style={s.button}
        onPress={() =>
          void act(async () => {
            // The lottery part of the compliance export: the last 30 days, one reconciled row per day.
            const csv = await apiText(`${base}/export.csv?from=${day(29)}&to=${day(0)}`, token);
            const name = `lottery-${day(29)}-to-${day(0)}.csv`;
            if (Platform.OS === 'web') {
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
              const el = document.createElement('a');
              el.href = url;
              el.download = name;
              el.click();
              URL.revokeObjectURL(url);
            } else await Share.share({ title: name, message: csv });
          }, 'Exported.')
        }
      >
        <Text style={s.buttonText}>Export last 30 days (CSV)</Text>
      </Pressable>
      <GamesCard games={state.games} onAdd={(g) => act(() => api(`${base}/games`, token, g), `Game ${g.game_number} added.`)} />
    </ScrollView>
  );
}

function Reconciliation({ d }: { d: LotteryDay }) {
  const diff = (label: string, v: number | null) =>
    v === null ? null : (
      <View style={s.line}>
        <Text style={s.name}>{label}</Text>
        <Text style={[s.money, v !== 0 && { color: AMBER }]}>{v === 0 ? 'matches' : `${v > 0 ? '+' : '−'}${usd(Math.abs(v))}`}</Text>
      </View>
    );
  return (
    <View style={s.card}>
      <Text style={s.label}>Reconciliation · {d.business_date}</Text>
      {d.instant.map((g) => (
        <Text key={g.game_number} style={s.muted}>
          #{g.game_number} {g.game_name}: {g.tickets} tickets · {usd(g.amount_cents)}
        </Text>
      ))}
      <View style={s.line}>
        <Text style={s.name}>Scratch-offs sold (bin count)</Text>
        <Text style={s.money}>{d.counted ? usd(d.instant_cents) : 'not counted'}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.name}>Lottery rung at the register</Text>
        <Text style={s.money}>{usd(d.rung_cents)}</Text>
      </View>
      <View style={s.line}>
        <Text style={s.name}>Payouts from the drawer</Text>
        <Text style={s.money}>{usd(d.drawer_payouts_cents)}</Text>
      </View>
      {d.terminal ? (
        <Text style={s.muted}>
          Terminal: online sales {usd(d.terminal.online_sales_cents)} · cashed {usd(d.terminal.cashes_cents)}
        </Text>
      ) : (
        <Text style={s.muted}>Enter the terminal’s daily report below to reconcile.</Text>
      )}
      {diff('Rung vs counted + online', d.sales_difference_cents)}
      {diff('Paid out vs cashed', d.payout_difference_cents)}
    </View>
  );
}

function CountCard({ active, date, onSave }: { active: LotteryPack[]; date: string; onSave: (entries: { pack_id: string; next_ticket: number; sold_out: boolean }[]) => void }) {
  const [v, setV] = useState<Record<string, { t: string; out: boolean }>>({});
  if (active.length === 0) return null;
  const ready = active.every((p) => v[p.pack_id]?.t || v[p.pack_id]?.out);
  return (
    <View style={s.card}>
      <Text style={s.label}>Bin count · {date}</Text>
      <Text style={s.muted}>For each bin, the number on the next ticket to sell.</Text>
      {active.map((p) => (
        <View key={p.pack_id} style={s.line}>
          <Text style={[s.name, { flex: 1 }]}>
            Bin {p.bin} · #{p.game_number} {usd(p.price_cents)}
          </Text>
          <TextInput
            style={[s.input, { width: 70 }]}
            value={v[p.pack_id]?.t ?? ''}
            onChangeText={(t) => setV((x) => ({ ...x, [p.pack_id]: { t: t.replace(/[^0-9]/g, '').slice(0, 3), out: x[p.pack_id]?.out ?? false } }))}
            keyboardType="number-pad"
            placeholder="000"
          />
          <Text style={s.muted}>out</Text>
          <Switch value={v[p.pack_id]?.out ?? false} onValueChange={(out) => setV((x) => ({ ...x, [p.pack_id]: { t: x[p.pack_id]?.t ?? '', out } }))} />
        </View>
      ))}
      <Pressable
        style={[s.button, !ready && { opacity: 0.5 }]}
        disabled={!ready}
        onPress={() => onSave(active.map((p) => ({ pack_id: p.pack_id, next_ticket: v[p.pack_id]?.out ? p.tickets_per_pack : Number(v[p.pack_id]?.t || 0), sold_out: !!v[p.pack_id]?.out })))}
      >
        <Text style={s.buttonText}>Save count</Text>
      </Pressable>
    </View>
  );
}

function TerminalCard({ d, onSave }: { d: LotteryDay | null; onSave: (online: number, cashes: number) => void }) {
  const [online, setOnline] = useState('');
  const [cashes, setCashes] = useState('');
  const parse = (x: string) => {
    try {
      return x.trim() ? parseUsdToCents(x) : null;
    } catch {
      return null;
    }
  };
  const o = parse(online);
  const c = parse(cashes);
  return (
    <View style={s.card}>
      <Text style={s.label}>State terminal report{d?.terminal ? ' (entered, re-enter to correct)' : ''}</Text>
      <View style={s.line}>
        <Text style={[s.name, { flex: 1 }]}>Online (draw) sales $</Text>
        <TextInput style={[s.input, { width: 110 }]} value={online} onChangeText={setOnline} keyboardType="decimal-pad" />
      </View>
      <View style={s.line}>
        <Text style={[s.name, { flex: 1 }]}>Cashed (winners paid) $</Text>
        <TextInput style={[s.input, { width: 110 }]} value={cashes} onChangeText={setCashes} keyboardType="decimal-pad" />
      </View>
      <Pressable style={[s.button, (o === null || c === null) && { opacity: 0.5 }]} disabled={o === null || c === null} onPress={() => onSave(o!, c!)}>
        <Text style={s.buttonText}>Save terminal report</Text>
      </Pressable>
    </View>
  );
}

function PacksCard({
  received,
  active,
  games,
  onReceive,
  onActivate,
  onClose,
}: {
  received: LotteryPack[];
  active: LotteryPack[];
  games: LotteryGame[];
  onReceive: (gameId: string, pack: string) => void;
  onActivate: (packId: string, bin: number) => void;
  onClose: (packId: string, to: 'sold_out' | 'returned') => void;
}) {
  const [game, setGame] = useState<string | null>(null);
  const [pack, setPack] = useState('');
  const [bins, setBins] = useState<Record<string, string>>({});
  return (
    <View style={s.card}>
      <Text style={s.label}>Packs</Text>
      {active.map((p) => (
        <View key={p.pack_id} style={s.line}>
          <Text style={[s.name, { flex: 1 }]}>
            Bin {p.bin} · #{p.game_number} pack {p.pack_number}
          </Text>
          <Pressable style={s.small} onPress={() => onClose(p.pack_id, 'sold_out')}>
            <Text>Sold out</Text>
          </Pressable>
        </View>
      ))}
      {received.map((p) => (
        <View key={p.pack_id} style={s.line}>
          <Text style={[s.name, { flex: 1 }]}>
            #{p.game_number} pack {p.pack_number} · in the safe
          </Text>
          <TextInput style={[s.input, { width: 60 }]} value={bins[p.pack_id] ?? ''} onChangeText={(t) => setBins((b) => ({ ...b, [p.pack_id]: t.replace(/[^0-9]/g, '').slice(0, 2) }))} placeholder="bin" keyboardType="number-pad" />
          <Pressable style={s.small} disabled={!bins[p.pack_id]} onPress={() => onActivate(p.pack_id, Number(bins[p.pack_id]))}>
            <Text>Activate</Text>
          </Pressable>
          <Pressable style={s.small} onPress={() => onClose(p.pack_id, 'returned')}>
            <Text>Return</Text>
          </Pressable>
        </View>
      ))}
      <Text style={[s.muted, { marginTop: 8 }]}>Receive a pack</Text>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {games.filter((g) => g.active).map((g) => (
          <Pressable key={g.game_id} onPress={() => setGame(g.game_id)} style={[s.chip, game === g.game_id && s.chipOn]}>
            <Text style={game === g.game_id ? { color: '#fff' } : { color: C.ink }}>
              #{g.game_number} {usd(g.price_cents)}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.line}>
        <TextInput style={[s.input, { flex: 1 }]} value={pack} onChangeText={(t) => setPack(t.replace(/[^0-9]/g, '').slice(0, 10))} placeholder="Pack number" keyboardType="number-pad" />
        <Pressable
          style={[s.small, (!game || pack.length < 4) && { opacity: 0.5 }]}
          disabled={!game || pack.length < 4}
          onPress={() => {
            onReceive(game!, pack);
            setPack('');
          }}
        >
          <Text>Receive</Text>
        </Pressable>
      </View>
    </View>
  );
}

function GamesCard({ games, onAdd }: { games: LotteryGame[]; onAdd: (g: { game_number: string; name: string; price_cents: number; tickets_per_pack: number }) => void }) {
  const [f, setF] = useState({ number: '', name: '', price: '', size: '' });
  let price: number | null = null;
  try {
    price = f.price ? parseUsdToCents(f.price) : null;
  } catch {
    price = null;
  }
  const ok = /^[0-9]{3,5}$/.test(f.number) && f.name.trim() && price !== null && Number(f.size) >= 10;
  return (
    <View style={s.card}>
      <Text style={s.label}>Games</Text>
      {games.map((g) => (
        <Text key={g.game_id} style={s.muted}>
          #{g.game_number} {g.name} · {usd(g.price_cents)} · {g.tickets_per_pack} per pack
        </Text>
      ))}
      <View style={[s.row, { flexWrap: 'wrap', marginTop: 6 }]}>
        <TextInput style={[s.input, { width: 80 }]} value={f.number} onChangeText={(t) => setF({ ...f, number: t.replace(/[^0-9]/g, '').slice(0, 5) })} placeholder="Game #" keyboardType="number-pad" />
        <TextInput style={[s.input, { flex: 1, minWidth: 120 }]} value={f.name} onChangeText={(t) => setF({ ...f, name: t })} placeholder="Name" />
        <TextInput style={[s.input, { width: 70 }]} value={f.price} onChangeText={(t) => setF({ ...f, price: t })} placeholder="$ price" keyboardType="decimal-pad" />
        <TextInput style={[s.input, { width: 80 }]} value={f.size} onChangeText={(t) => setF({ ...f, size: t.replace(/[^0-9]/g, '').slice(0, 4) })} placeholder="per pack" keyboardType="number-pad" />
      </View>
      <Pressable
        style={[s.button, !ok && { opacity: 0.5 }]}
        disabled={!ok}
        onPress={() => {
          onAdd({ game_number: f.number, name: f.name.trim(), price_cents: price!, tickets_per_pack: Number(f.size) });
          setF({ number: '', name: '', price: '', size: '' });
        }}
      >
        <Text style={s.buttonText}>Add game</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 6 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  muted: { color: C.muted, fontSize: 13 },
  error: { color: C.red },
  row: { flexDirection: 'row', gap: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: C.ink, fontWeight: '600' },
  money: { color: C.black, fontWeight: '800', fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff', color: C.ink },
  small: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  button: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#fff', fontWeight: '700' },
});
