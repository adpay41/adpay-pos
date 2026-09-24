/**
 * Alerts inbox and register status (build plan P4, Bible 2.6 / L37–L38). The owner sees what needs
 * them: a register offline more than 5 minutes, a printer or scanner problem, a PIN lockout,
 * unusually many voids. Push, SMS and WhatsApp delivery arrive once those accounts exist; until
 * then this inbox is where alerts land.
 */
import { ALERT_RULES, MERCHANT_ALERT_RULES, parseUsdToCents, registerHealth, type Alert, type AlertRule, type AlertSettings, type FleetRow } from '@adpay/shared';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C, dollars } from './theme';

function ago(at: string | null, now: number): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} d ago`;
}

export function AlertsTab({ token }: { token: string }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [registers, setRegisters] = useState<FleetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api<{ alerts: Alert[] }>('/merchant/alerts', token), api<{ registers: FleetRow[] }>('/merchant/registers', token)]);
      setAlerts(a.alerts);
      setRegisters(r.registers.filter((x) => x.status === 'active'));
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function ack(a: Alert) {
    try {
      await api(`/merchant/alerts/${a.alert_id}/ack`, token, {});
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!alerts || !registers) return error ? <Text style={[s.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} />;
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.label}>Alerts</Text>
      {alerts.length === 0 ? (
        <View style={s.card}>
          <Text style={s.muted}>All clear. Nothing needs you right now.</Text>
        </View>
      ) : (
        alerts.map((a) => (
          <View key={a.alert_id} style={[s.card, a.severity === 'critical' && s.critical]}>
            <Text style={s.title}>{a.title}</Text>
            <Text style={s.mutedSmall}>
              {a.location_name ? `${a.location_name} · ` : ''}since {ago(a.opened_at, now)}
              {a.acknowledged_at ? ` · seen by ${a.acknowledged_by_name ?? 'someone'}` : ''}
            </Text>
            {!a.acknowledged_at ? (
              <Pressable onPress={() => void ack(a)} style={s.small}>
                <Text style={s.smallText}>Got it</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      <Text style={[s.label, { marginTop: 8 }]}>Registers</Text>
      <View style={s.card}>
        {registers.map((r) => {
          const h = registerHealth(r.last_heartbeat_at, now);
          return (
            <View key={r.register_id} style={s.line}>
              <View style={[s.dot, h === 'online' ? s.dotOk : h === 'stale' ? s.dotWarn : s.dotOff]} />
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{r.register_name}</Text>
                <Text style={s.mutedSmall}>
                  {r.location_name} · {h === 'online' ? 'online' : h === 'never' ? 'never connected' : `last seen ${ago(r.last_heartbeat_at, now)}`}
                  {r.queued ? ` · ${r.queued} sales waiting to sync` : ''}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      <AlertSettingsCard token={token} onSaved={() => void load()} />
      {error ? <Text style={s.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 10, maxWidth: 640, width: '100%', alignSelf: 'center' },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 },
  critical: { borderLeftWidth: 4, borderLeftColor: C.black },
  title: { color: C.ink, fontWeight: '700' },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  error: { color: C.red },
  small: { alignSelf: 'flex-start', marginTop: 6, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  smallText: { fontWeight: '600', color: C.ink },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  dot: { width: 10, height: 10, borderRadius: 5 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#fff', color: C.ink },
  dotOk: { backgroundColor: C.green },
  dotWarn: { backgroundColor: '#c77700' },
  dotOff: { backgroundColor: '#999' },
});

/**
 * Which alerts reach this owner, and the thresholds behind the money ones (P11). Muting hides an
 * alert here only; AD Pay support still sees it.
 */
function AlertSettingsCard({ token, onSaved }: { token: string; onSaved: () => void }) {
  const [cur, setCur] = useState<AlertSettings | null>(null);
  const [f, setF] = useState({ refund: '', short: '', nosale: '', drop: '' });
  const [muted, setMuted] = useState<AlertRule[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<AlertSettings>('/merchant/alert-settings', token).then((x) => {
      setCur(x);
      setMuted(x.muted);
      setF({ refund: dollars(x.large_refund_cents), short: dollars(x.drawer_short_cents), nosale: String(x.no_sale_spike), drop: dollars(x.drop_over_cents) });
    }, (e) => setMsg((e as Error).message));
  }, [token]);

  async function save() {
    setMsg(null);
    try {
      const body = { muted, large_refund_cents: parseUsdToCents(f.refund), drawer_short_cents: parseUsdToCents(f.short), no_sale_spike: Number(f.nosale), drop_over_cents: parseUsdToCents(f.drop) };
      setCur(await api<AlertSettings>('/merchant/alert-settings', token, body, 'PUT'));
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (!cur) return null;
  return (
    <>
      <Pressable onPress={() => setOpen((o) => !o)}>
        <Text style={[s.label, { marginTop: 8 }]}>Alert settings {open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={s.card}>
          {MERCHANT_ALERT_RULES.map((r) => (
            <View key={r} style={s.line}>
              <Text style={[s.title, { flex: 1, fontWeight: '500' }]}>{ALERT_RULES[r].label}</Text>
              <Switch value={!muted.includes(r)} onValueChange={(on) => setMuted((m) => (on ? m.filter((x) => x !== r) : [...m, r]))} />
            </View>
          ))}
          <Text style={[s.mutedSmall, { marginTop: 8 }]}>Refund or void at or over ($)</Text>
          <TextInput style={s.input} value={f.refund} onChangeText={(v) => setF({ ...f, refund: v })} keyboardType="decimal-pad" />
          <Text style={s.mutedSmall}>Drawer counted short by more than ($)</Text>
          <TextInput style={s.input} value={f.short} onChangeText={(v) => setF({ ...f, short: v })} keyboardType="decimal-pad" />
          <Text style={s.mutedSmall}>Ask for a safe drop when a drawer holds more than ($)</Text>
          <TextInput style={s.input} value={f.drop} onChangeText={(v) => setF({ ...f, drop: v })} keyboardType="decimal-pad" />
          <Text style={s.mutedSmall}>Drawer opened without a sale, times per register per day</Text>
          <TextInput style={s.input} value={f.nosale} onChangeText={(v) => setF({ ...f, nosale: v.replace(/\D/g, '') })} keyboardType="number-pad" />
          <Pressable onPress={() => void save()} style={s.small}>
            <Text style={s.smallText}>Save alert settings</Text>
          </Pressable>
          {msg ? <Text style={s.mutedSmall}>{msg}</Text> : null}
        </View>
      ) : null}
    </>
  );
}
