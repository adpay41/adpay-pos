/**
 * Tax-free sale on the register (ADR 0049): the whole ticket without sales tax, for a buyer with a
 * resale or exemption certificate. Needs `ticket.tax_exempt` (a manager's PIN for a cashier); why and
 * the certificate number go on the event, the receipt and the sales-tax report.
 */
import { TAX_EXEMPT_REASONS, type CashierKey, type FoldedSale } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { tk, useT } from './i18n';
import { C } from './theme';

type Reason = (typeof TAX_EXEMPT_REASONS)[number];

export const TAX_EXEMPT_LABEL: Record<Reason, CashierKey> = {
  resale: tk('Resale certificate'),
  nonprofit: tk('Non-profit'),
  government: tk('Government'),
  diplomat: tk('Diplomat'),
  other: tk('Other exemption'),
};

export function TaxFreePanel({
  sale,
  onApply,
  onRemove,
  onCancel,
}: {
  sale: FoldedSale;
  onApply: (x: { reason: Reason; certificate: string | null }) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState<Reason | null>((sale.tax_exempt?.reason as Reason | null) ?? null);
  const [certificate, setCertificate] = useState(sale.tax_exempt?.certificate ?? '');
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>{t('Tax-free sale')}</Text>
      <Text style={s.muted}>{t('No sales tax on this ticket. Keep a copy of the buyer’s certificate.')}</Text>
      <View style={s.row}>
        {TAX_EXEMPT_REASONS.map((r) => (
          <Pressable key={r} style={[s.chip, reason === r && s.chipOn]} onPress={() => setReason(r)}>
            <Text style={[s.chipText, reason === r && s.chipTextOn]}>{t(TAX_EXEMPT_LABEL[r])}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput style={s.input} value={certificate} onChangeText={setCertificate} placeholder={t('Certificate number (optional)')} maxLength={40} autoCapitalize="characters" />
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>{t('Back')}</Text>
        </Pressable>
        {sale.tax_exempt ? (
          <Pressable style={s.ghost} onPress={onRemove}>
            <Text>{t('Charge tax again')}</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.primary, !reason && s.disabled]} disabled={!reason} onPress={() => reason && onApply({ reason, certificate: certificate.trim() || null })}>
          <Text style={s.primaryText}>{t('Make it tax-free')}</Text>
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
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, backgroundColor: '#fff' },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  primary: { flexGrow: 2, borderRadius: 8, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', backgroundColor: C.black },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 17 },
  disabled: { opacity: 0.4 },
});
