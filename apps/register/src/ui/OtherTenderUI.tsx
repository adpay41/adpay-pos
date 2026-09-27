/**
 * Check and other tenders on the register (ADR 0050): a check, EBT, a gift card, a house account or
 * another named tender, at the cash price, with a reference (check number, card last digits). It
 * pays at most what's left and gives no change; less pays part and the rest goes on another tender.
 * The amount comes from the pad when something is typed, else everything that's left.
 */
import { OTHER_TENDER_KINDS, cents, type CashierKey, type Cents } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { tk, useT } from './i18n';
import { C, usd } from './theme';

type Kind = 'check' | (typeof OTHER_TENDER_KINDS)[number];

const LABEL: Record<Kind, CashierKey> = {
  check: tk('Check'),
  ebt: tk('EBT'),
  gift_card: tk('Gift card'),
  house_account: tk('House account'),
  other: tk('Other tender'),
};
const KINDS: Kind[] = ['check', 'ebt', 'gift_card', 'house_account', 'other'];

export function OtherTenderPanel({
  due,
  typedCents,
  onTake,
  onCancel,
}: {
  /** What's left at the cash price. */
  due: number;
  typedCents: number;
  onTake: (x: { kind: 'check' | 'other'; other_kind: (typeof OTHER_TENDER_KINDS)[number] | null; amount: Cents; reference: string | null }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<Kind>('check');
  const [reference, setReference] = useState('');
  const amount = typedCents > 0 ? typedCents : due;
  const tooMuch = amount > due;
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>{t('Check or other tender')}</Text>
      <View style={s.row}>
        {KINDS.map((k) => (
          <Pressable key={k} style={[s.chip, kind === k && s.chipOn]} onPress={() => setKind(k)}>
            <Text style={[s.chipText, kind === k && s.chipTextOn]}>{t(LABEL[k])}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={s.input}
        value={reference}
        onChangeText={setReference}
        placeholder={kind === 'check' ? t('Check number (optional)') : t('Reference (optional)')}
        maxLength={40}
        autoCapitalize="characters"
      />
      <Text style={tooMuch ? s.warn : s.muted}>
        {tooMuch
          ? t('Only {amount} is left: a check or other tender can’t be for more (no change).', { amount: usd(due) })
          : amount < due
            ? t('Pays {amount} now; the rest on another tender.', { amount: usd(amount) })
            : t('Pays the rest: {amount} (the cash price).', { amount: usd(amount) })}
      </Text>
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>{t('Back')}</Text>
        </Pressable>
        {/* Black, not red: it carries an amount. */}
        <Pressable
          style={[s.primary, tooMuch && s.disabled]}
          disabled={tooMuch}
          onPress={() =>
            onTake({ kind: kind === 'check' ? 'check' : 'other', other_kind: kind === 'check' ? null : kind, amount: cents(amount), reference: reference.trim() || null })
          }
        >
          <Text style={s.primaryText}>{t('Take {amount} as {tender}', { amount: usd(amount), tender: t(LABEL[kind]) })}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  muted: { color: C.muted },
  warn: { color: C.amber, fontWeight: '700' },
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
