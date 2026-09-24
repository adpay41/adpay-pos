/**
 * Alerts inbox and register status (build plan P4, Bible 2.6 / L37–L38). The owner sees what needs
 * them: a register offline more than 5 minutes, a printer or scanner problem, a PIN lockout,
 * unusually many voids. Push, SMS and WhatsApp delivery arrive once those accounts exist; until
 * then this inbox is where alerts land.
 */
import { registerHealth, type Alert, type FleetRow } from '@adpay/shared';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

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
  dotOk: { backgroundColor: C.green },
  dotWarn: { backgroundColor: '#c77700' },
  dotOff: { backgroundColor: '#999' },
});
