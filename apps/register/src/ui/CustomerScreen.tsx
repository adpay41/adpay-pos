/**
 * The customer-facing 10.1" screen. Cash and card prices side by side on every line and total,
 * before tender (NJ/NY posted-pricing). In the browser this runs in its own window.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { createDisplayChannel, type DisplayState } from '../core/display';
import { CUSTOMER_COPY as T } from './copy';
import { C, usd } from './theme';

export function CustomerScreen() {
  const [state, setState] = useState<DisplayState | null>(null);
  useEffect(() => createDisplayChannel().subscribe(setState), []);

  if (!state || state.phase === 'idle') {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.brand}>
          <Text style={s.mark}> AD </Text> Pay
        </Text>
        <Text style={s.welcome}>{state?.merchant_name ?? 'Welcome'}</Text>
        <Text style={s.muted}>{T.welcome_note}</Text>
      </View>
    );
  }

  if (state.phase === 'paid') {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.thanks}>{T.thanks}</Text>
        <Text style={s.paid}>
          {T.paid} {usd(state.paid_cents ?? 0)}
        </Text>
        {state.change_cents ? (
          <Text style={s.change}>
            {T.your_change} {usd(state.change_cents)}
          </Text>
        ) : null}
      </View>
    );
  }

  // Card: a still, clear instruction. No processor name, no spinner (Bible Part 4).
  if (state.phase === 'card' || state.phase === 'approved' || state.phase === 'declined') {
    return (
      <View style={[s.root, s.center]}>
        {state.paid_so_far_cents ? (
          <Text style={s.muted}>
            {T.paid_so_far} {usd(state.paid_so_far_cents)}
          </Text>
        ) : null}
        <Text style={s.cardLabel}>{T.card_amount}</Text>
        <Text style={s.cardAmount}>{usd(state.card_amount_cents ?? 0)}</Text>
        {state.phase === 'card' ? <Text style={s.cardPrompt}>{T.tap_card}</Text> : null}
        {state.phase === 'approved' ? <Text style={s.approved}>{T.approved}</Text> : null}
        {state.phase === 'declined' ? <Text style={s.declined}>{T.declined}</Text> : null}
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.headText}>{state.merchant_name}</Text>
      </View>
      <View style={s.colsHead}>
        <Text style={[s.colName, s.colLabel]}>Item</Text>
        <Text style={[s.colPrice, s.colLabel]}>Cash</Text>
        <Text style={[s.colPrice, s.colLabel]}>Card</Text>
      </View>
      <ScrollView style={{ flex: 1 }}>
        {state.lines.map((l) => (
          <View key={l.line_id} style={s.row}>
            <Text style={s.colName} numberOfLines={2}>
              {l.qty > 1 ? `${l.qty} × ` : ''}
              {l.name}
            </Text>
            <Text style={s.colPrice}>{usd(l.cash_cents)}</Text>
            <Text style={[s.colPrice, s.cardCol]}>{usd(l.card_cents)}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={s.totals}>
        <View style={s.totalBox}>
          <Text style={s.totalLabel}>{T.pay_cash}</Text>
          <Text style={s.totalValue}>{usd(state.cash_total_cents)}</Text>
          <Text style={s.mutedSmall}>incl. tax {usd(state.tax_cash_cents)}</Text>
        </View>
        <View style={s.totalBox}>
          <Text style={s.totalLabel}>{T.pay_card}</Text>
          <Text style={s.totalValue}>{usd(state.card_total_cents)}</Text>
          <Text style={s.mutedSmall}>incl. tax {usd(state.tax_card_cents)}</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  brand: { fontSize: 44, fontWeight: '800', color: C.ink },
  mark: { backgroundColor: C.red, color: '#fff' },
  welcome: { fontSize: 26, fontWeight: '600', color: C.ink },
  muted: { color: C.muted, fontSize: 16 },
  mutedSmall: { color: C.muted, fontSize: 13 },
  thanks: { fontSize: 48, fontWeight: '800', color: C.green },
  cardLabel: { fontSize: 20, color: C.muted, fontWeight: '700' },
  cardAmount: { fontSize: 64, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  cardPrompt: { fontSize: 26, fontWeight: '700', color: C.ink, textAlign: 'center', maxWidth: 640 },
  approved: { fontSize: 32, fontWeight: '800', color: C.green },
  // Declined is ink, not red: it sits right under an amount.
  declined: { fontSize: 24, fontWeight: '700', color: C.ink, textAlign: 'center', maxWidth: 640 },
  paid: { fontSize: 28, color: C.ink },
  change: { fontSize: 32, fontWeight: '700', color: C.green },
  head: { backgroundColor: C.black, padding: 16 },
  headText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  colsHead: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  colLabel: { color: C.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  row: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, alignItems: 'center' },
  colName: { flex: 1, fontSize: 20, color: C.ink },
  colPrice: { width: 120, textAlign: 'right', fontSize: 20, fontWeight: '600', color: C.black, fontVariant: ['tabular-nums'] },
  cardCol: { color: C.muted },
  totals: { flexDirection: 'row', gap: 16, padding: 20, borderTopWidth: 2, borderTopColor: C.black },
  totalBox: { flex: 1, backgroundColor: C.ground, borderRadius: 12, padding: 16 },
  totalLabel: { fontSize: 16, color: C.muted, fontWeight: '700' },
  totalValue: { fontSize: 40, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
});
