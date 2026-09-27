/**
 * Refund without a receipt (ADR 0051): pick why, then ring what's coming back on a return ticket and
 * refund it in cash. Needs `refund.no_receipt` (a manager's PIN for a cashier); the reason is on the
 * ticket, the refund and the audit trail.
 */
import type { CashierKey } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tk, useT } from './i18n';
import { C } from './theme';

const REASONS: CashierKey[] = [tk('Defective'), tk('Wrong item'), tk('Changed mind'), tk('Expired'), tk('Other reason')];

export function ReturnStartPanel({ onStart, onCancel }: { onStart: (reason: string) => void; onCancel: () => void }) {
  const t = useT();
  const [reason, setReason] = useState<CashierKey | null>(null);
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>{t('Return without a receipt')}</Text>
      <Text style={s.muted}>{t('Ring what the customer brings back. It is refunded at today’s price with tax, in cash.')}</Text>
      <View style={s.row}>
        {REASONS.map((r) => (
          <Pressable key={r} style={[s.chip, reason === r && s.chipOn]} onPress={() => setReason(r)}>
            <Text style={[s.chipText, reason === r && s.chipTextOn]}>{t(r)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>{t('Back')}</Text>
        </Pressable>
        {/* The reason is stored in English, like other event reasons. */}
        <Pressable style={[s.primary, !reason && s.disabled]} disabled={!reason} onPress={() => reason && onStart(reason)}>
          <Text style={s.primaryText}>{t('Start the return')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  muted: { color: C.muted },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '700' },
  chipTextOn: { color: '#fff' },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  primary: { flexGrow: 2, borderRadius: 8, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', backgroundColor: C.black },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 17 },
  disabled: { opacity: 0.4 },
});
