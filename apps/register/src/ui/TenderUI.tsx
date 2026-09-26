/**
 * Card tender on the register (build plan P9): charge the card price of what's left, or put part
 * on this card (two cards, or cash + card), wait for the terminal, then approved / declined /
 * couldn't reach it. Declines and errors leave the ticket open: try again, another card, or cash.
 * No spinner and no processor name on this screen or the customer's (Bible Part 4).
 */
import { cardAmountFor, type Cents, type FoldedSale } from '@adpay/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from './i18n';
import { NumberPad } from './SpeedUI';
import { C, usd } from './theme';

export type CardPhase =
  | { kind: 'ready' }
  | { kind: 'partial' }
  | { kind: 'waiting'; amount: number }
  | { kind: 'declined'; message: string | null }
  | { kind: 'error'; message: string | null; retry: { tender_id: string; amount: Cents } };

export function CardPanel({
  sale,
  phase,
  onCharge,
  onRetry,
  onPartial,
  onCash,
  onBack,
}: {
  sale: FoldedSale;
  phase: CardPhase;
  onCharge: (amount?: Cents) => void;
  onRetry: (pending: { tender_id: string; amount: Cents }) => void;
  onPartial: () => void;
  onCash: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const due = cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents);
  const paid = sale.tenders.filter((tender) => tender.approved).reduce((n, tender) => n + tender.amount_cents, 0);

  if (phase.kind === 'partial') {
    return (
      <NumberPad
        title={t('How much on this card?')}
        subtitle={t('Up to {amount}. The rest can go on another card or in cash.', { amount: usd(due) })}
        money
        max={due}
        confirmLabel={(c) => (c ? t('Charge {amount} to this card', { amount: usd(c) }) : t('Enter an amount'))}
        onCancel={onBack}
        onConfirm={(c) => onCharge(c as Cents)}
      />
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <View style={{ gap: 12, alignItems: 'center' }}>
        <Text style={s.title}>{t('Card — {amount}', { amount: usd(phase.amount) })}</Text>
        <Text style={s.big}>{t('Customer: tap, insert or swipe on the card machine')}</Text>
        <Text style={s.muted}>{t('The screen updates on its own when the card machine answers.')}</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>{t('Card')}</Text>
      {paid > 0 ? <Text style={s.muted}>{t('Paid so far {amount}', { amount: usd(paid) })}</Text> : null}
      <View style={s.box}>
        <Text style={s.boxLabel}>{paid > 0 ? t('Left to pay by card') : t('Card price')}</Text>
        <Text style={s.boxValue}>{usd(due)}</Text>
        <Text style={s.muted}>{t('or {amount} in cash', { amount: usd(sale.remaining_cash_cents) })}</Text>
      </View>
      {phase.kind === 'declined' ? (
        <Text style={s.warn}>
          {phase.message
            ? t('Declined — {message}. Try again, another card, or cash.', { message: phase.message })
            : t('Declined. Try again, another card, or cash.')}
        </Text>
      ) : null}
      {phase.kind === 'error' ? <Text style={s.warn}>
          {phase.message ?? t('The card machine didn’t answer.')} {t('Nothing was charged twice: trying again is safe.')}
        </Text> : null}
      <View style={s.row}>
        {phase.kind === 'error' ? (
          // Black, not red: the button carries an amount.
          <Pressable style={[s.primary, s.dark]} onPress={() => onRetry(phase.retry)}>
            <Text style={s.primaryText}>{t('Try {amount} again', { amount: usd(phase.retry.amount) })}</Text>
          </Pressable>
        ) : (
          <Pressable style={[s.primary, s.dark]} onPress={() => onCharge()}>
            <Text style={s.primaryText}>{t('Charge {amount}', { amount: usd(due) })}</Text>
          </Pressable>
        )}
      </View>
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onPartial}>
          <Text>{t('Part on this card')}</Text>
        </Pressable>
        <Pressable style={s.ghost} onPress={onCash}>
          <Text>{t('Cash instead')}</Text>
        </Pressable>
        <Pressable style={s.ghost} onPress={onBack}>
          <Text>{t('Back')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  big: { fontSize: 22, fontWeight: '700', color: C.ink, textAlign: 'center' },
  muted: { color: C.muted },
  warn: { color: C.amber, fontWeight: '700' },
  box: { backgroundColor: C.ground, borderRadius: 10, padding: 14 },
  boxLabel: { fontSize: 12, color: C.muted, fontWeight: '700' },
  boxValue: { fontSize: 34, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  primary: { flexGrow: 1, borderRadius: 8, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  dark: { backgroundColor: C.black },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 17 },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
});
