/**
 * Z-reports in the merchant app (build plan P16, ADR 0025): every end of day taken at a register,
 * rebuilt by the server from the same events and checked against what the register printed. Tap
 * one to see the printout.
 */
import { renderZReport, type ZReport, type ZTotals } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C, usd } from './theme';

interface ZRow {
  event_id: string;
  register_name: string;
  location_name: string;
  closed_at: string;
  closed_by_name: string | null;
  declared: ZTotals;
  z: ZReport;
  mismatch: boolean;
}

export function ZReports({ token, from, to }: { token: string; from: string; to: string }) {
  const [rows, setRows] = useState<ZRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ reports: ZRow[] }>(`/merchant/zreports?from=${from}&to=${to}`, token).then(
      (r) => live && setRows(r.reports),
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [token, from, to]);

  if (!rows) return null;
  return (
    <View style={s.card}>
      <Text style={s.label}>End of day (Z-reports)</Text>
      {rows.length === 0 ? <Text style={s.muted}>No end of day taken in this period. At closing: register → End of day.</Text> : null}
      {rows.map((r) => (
        <Pressable key={r.event_id} onPress={() => setOpen(open === r.event_id ? null : r.event_id)} style={s.row}>
          <View style={s.line}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>
                Z #{r.z.z_number} · {r.register_name} · {r.z.business_date}
              </Text>
              <Text style={s.muted}>
                {r.z.sales_count} sales · cash {usd(r.z.by_tender.cash_cents)} · card {usd(r.z.by_tender.card_cents)} · tax {usd(r.z.tax_cents)}
                {r.closed_by_name ? ` · by ${r.closed_by_name}` : ''}
              </Text>
              {r.mismatch ? <Text style={s.warn}>The register’s printout differs from the sales that reached us. Ask AD Pay support (Help tab) to look.</Text> : null}
            </View>
            <Text style={s.money}>{usd(r.z.gross_cents)}</Text>
          </View>
          {open === r.event_id ? (
            <View style={s.paper}>
              {renderZReport(r.z, { merchant_name: '', location_name: r.location_name, register_name: r.register_name, timezone: 'America/New_York' }).map((l, i) => (
                <Text key={i} style={s.mono}>
                  {l}
                </Text>
              ))}
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  muted: { color: C.muted },
  warn: { color: '#a15c00', fontWeight: '600' },
  row: { borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { color: C.ink, fontWeight: '600' },
  money: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'] },
  paper: { backgroundColor: '#fafafa', borderRadius: 6, padding: 8, marginTop: 6 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, color: C.ink },
});
