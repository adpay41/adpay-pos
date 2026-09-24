/**
 * Hours from the time clock (build plan P15, Bible 1.8 / 2.5): this week or last, per person per
 * day, weekly overtime flagged, and the payroll export (CSV) to hand to the accountant or payroll
 * service. Punches happen at the register; nothing here is typed.
 */
import { hhmm, localDate, timesheetCsv, type Timesheet } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

/** Monday..Sunday of this week (offset 0) or an earlier one, store-local (the app runs in the store's zone). */
function week(offset: number): { from: string; to: string } {
  const today = new Date(`${localDate(new Date(), 'America/New_York')}T12:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86_400_000 - offset * 7 * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export function HoursTab({ token }: { token: string }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Timesheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = week(offset);

  useEffect(() => {
    let live = true;
    setData(null);
    api<Timesheet>(`/merchant/timesheet?from=${range.from}&to=${range.to}`, token).then(
      (d) => live && setData(d),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [range.from, range.to, token]);

  async function exportCsv() {
    if (!data) return;
    const csv = timesheetCsv(data);
    const name = `hours-${data.from}-to-${data.to}.csv`;
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ title: name, message: csv });
    }
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.segment}>
        {[0, 1].map((o) => (
          <Pressable key={o} onPress={() => setOffset(o)} style={[s.segItem, offset === o && s.segOn]}>
            <Text style={[s.segText, offset === o && { color: '#fff' }]}>{o === 0 ? 'This week' : 'Last week'}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <>
          <View style={s.card}>
            <Text style={s.label}>
              {data.from} – {data.to}
            </Text>
            {data.rows.length === 0 ? <Text style={s.muted}>Nobody clocked in. Staff clock in at the register (tap “Clock in” by their name).</Text> : null}
            {data.rows.map((r) => (
              <View key={r.user_id} style={s.line}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{r.name}</Text>
                  <Text style={s.muted}>
                    {Object.keys(r.by_day).length} days
                    {r.open_shift ? ' · on the clock now' : ''}
                    {r.overtime_minutes > 0 ? ` · overtime ${hhmm(r.overtime_minutes)}` : ''}
                  </Text>
                </View>
                <Text style={[s.hours, r.overtime_minutes > 0 && { color: AMBER }]}>{hhmm(r.total_minutes)}</Text>
              </View>
            ))}
          </View>
          <Pressable style={s.button} onPress={() => void exportCsv()} disabled={data.rows.length === 0}>
            <Text style={s.buttonText}>Export for payroll (CSV)</Text>
          </Pressable>
          <Text style={s.muted}>Overtime is over 40 hours in a Monday–Sunday week. Hours count on the day the shift started.</Text>
        </>
      )}
    </ScrollView>
  );
}

const AMBER = '#a15c00';
const s = StyleSheet.create({
  page: { padding: 16, gap: 10, maxWidth: 640, width: '100%', alignSelf: 'center' },
  segment: { flexDirection: 'row', backgroundColor: '#e9e9e9', borderRadius: 8, padding: 3 },
  segItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segOn: { backgroundColor: C.black },
  segText: { fontWeight: '600', color: C.ink },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  muted: { color: C.muted },
  error: { color: C.red },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  name: { color: C.ink, fontWeight: '600' },
  hours: { color: C.black, fontWeight: '800', fontSize: 18, fontVariant: ['tabular-nums'] },
  button: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
});
