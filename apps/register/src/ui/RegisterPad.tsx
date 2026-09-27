/**
 * The register pad, always on the main screen (register layout A, ADR 0045): what the cashier types
 * (an amount, filled from the cents column: 2-0-0-0 → $20.00), quick cash for the bills customers
 * hand over, and the tenders. It replaces the cash modal the tester objected to: one tap on $20
 * takes $20 and gives change.
 *
 * Cash with nothing typed takes the exact amount. Cash with an amount takes that; less than what's
 * due pays part (the rest by card) when card is available. Card with an amount charges that much to
 * this card (split / two cards). Buttons that carry amounts are black, never red.
 */
import { quickCashOptions, cents, type Cents } from '@adpay/shared';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { padCents, pressPad } from '../core/pad';
import { useT } from './i18n';
import { C, usd } from './theme';


export function RegisterPad({
  digits,
  onDigits,
  dueCash,
  dueCard,
  canTender,
  cardShown,
  cardOk,
  allowPart,
  onCash,
  onCard,
  onRejectBill,
  extraKeys,
}: {
  digits: string;
  onDigits: (d: string) => void;
  /** What's left to pay at the cash price, and at the card price. */
  dueCash: number;
  dueCard: number;
  /** There is a ticket with something on it. */
  canTender: boolean;
  cardShown: boolean;
  cardOk: boolean;
  /** Cash less than what's due may pay part (the rest by card). */
  allowPart: boolean;
  onCash: (amount: Cents, partial: boolean) => void;
  onCard: (amount: Cents | undefined) => void;
  onRejectBill: () => void;
  /** Keys that use the typed number for something else (@ quantity, PLU, department ring). */
  extraKeys?: ReactNode;
}) {
  const t = useT();
  const typed = padCents(digits);
  const quick = canTender ? quickCashOptions(cents(dueCash), 5) : [];
  const cashLabel = !canTender
    ? t('Cash')
    : typed === 0
      ? t('Cash {amount}', { amount: usd(dueCash) })
      : typed >= dueCash
        ? t('Cash {amount}', { amount: usd(typed) })
        : allowPart
          ? t('Part cash {amount}', { amount: usd(typed) })
          : t('Cash');
  const cashOk = canTender && (typed === 0 || typed >= dueCash || allowPart);
  const cardAmount = typed > 0 ? Math.min(typed, dueCard) : dueCard;

  return (
    <View style={s.pad}>
      <View style={s.left}>
        <View style={s.row}>
          <View style={s.display}>
            <Text style={s.displayValue} accessibilityLabel={t('Typed amount')}>
              {digits ? usd(typed) : ' '}
            </Text>
            {digits ? <Text style={s.displayHint}>{t('Tap a tender, or a key that uses the number')}</Text> : null}
          </View>
          <Pressable style={[s.clear, !digits && s.disabled]} disabled={!digits} onPress={() => onDigits('')}>
            <Text style={s.smallText}>{t('Clear')}</Text>
          </Pressable>
        </View>
        <View style={s.row}>
          <View style={s.keys}>
            {['7', '8', '9', '⌫', '4', '5', '6', '00', '1', '2', '3', '0'].map((k) => (
              <Pressable key={k} style={s.key} onPress={() => onDigits(pressPad(digits, k))} accessibilityLabel={k === '⌫' ? t('Delete') : k}>
                <Text style={s.keyText}>{k}</Text>
              </Pressable>
            ))}
          </View>
          {extraKeys ? <View style={s.extra}>{extraKeys}</View> : null}
        </View>
      </View>

      <View style={s.right}>
        <View style={s.quickGrid}>
          {quick.map((o) => (
            <Pressable key={o} style={s.quick} onPress={() => onCash(o, false)} accessibilityLabel={o === dueCash ? t('Exact cash') : t('Cash {amount}', { amount: usd(o) })}>
              <Text style={s.quickText}>{o === dueCash ? t('Exact') : usd(o)}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.row}>
        <Pressable style={[s.tender, !cashOk && s.disabled]} disabled={!cashOk} onPress={() => onCash(cents(typed || dueCash), typed > 0 && typed < dueCash)}>
          <Text style={s.tenderText}>{cashLabel}</Text>
        </Pressable>
        {cardShown ? (
          <Pressable style={[s.tender, (!canTender || !cardOk) && s.disabled]} disabled={!canTender || !cardOk} onPress={() => onCard(typed > 0 ? cents(cardAmount) : undefined)}>
            <Text style={s.tenderText}>{canTender ? t('Card {amount}', { amount: usd(cardAmount) }) : t('Card')}</Text>
            {!cardOk ? <Text style={s.tenderSub}>{t('offline')}</Text> : null}
          </Pressable>
        ) : null}
        </View>
        <Pressable style={s.small} onPress={onRejectBill}>
          <Text style={s.smallText}>{t('Reject a bill')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  pad: { flexDirection: 'row', gap: 10, padding: 8, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: '#fff' },
  left: { flex: 3, gap: 6 },
  right: { flex: 2, gap: 6 },
  display: { flex: 1, backgroundColor: C.ground, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4, minHeight: 40, justifyContent: 'center' },
  displayValue: { fontSize: 22, fontWeight: '800', color: C.black, textAlign: 'right', fontVariant: ['tabular-nums'] },
  displayHint: { fontSize: 11, color: C.muted, textAlign: 'right' },
  clear: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#fff' },
  keys: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: { width: '23.5%', backgroundColor: C.ground, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  extra: { width: 110, gap: 6 },
  keyText: { fontSize: 20, fontWeight: '700', color: C.ink },
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  small: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 10, alignItems: 'center', backgroundColor: '#fff' },
  smallText: { color: C.ink, fontWeight: '600' },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  quick: { flexGrow: 1, minWidth: '30%', borderWidth: 1, borderColor: C.black, borderRadius: 8, paddingVertical: 10, alignItems: 'center', backgroundColor: '#fff' },
  quickText: { fontSize: 17, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  tender: { flex: 1, backgroundColor: C.black, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  tenderText: { color: '#fff', fontWeight: '800', fontSize: 17, fontVariant: ['tabular-nums'] },
  tenderSub: { color: '#bbb', fontSize: 12 },
  disabled: { opacity: 0.4 },
});
