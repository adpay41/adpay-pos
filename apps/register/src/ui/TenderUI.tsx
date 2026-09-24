/**
 * Card tender on the register (build plan P9): charge the card price of what's left, or put part
 * on this card (two cards, or cash + card), wait for the terminal, then approved / declined /
 * couldn't reach it. Declines and errors leave the ticket open: try again, another card, or cash.
 * No spinner and no processor name on this screen or the customer's (Bible Part 4).
 */
import { cardAmountFor, type Cents, type FoldedSale } from '@adpay/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  const due = cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents);
  const paid = sale.tenders.filter((t) => t.approved).reduce((n, t) => n + t.amount_cents, 0);

  if (phase.kind === 'partial') {
    return (
      <NumberPad
        title="How much on this card?"
        subtitle={`Up to ${usd(due)}. The rest can go on another card or in cash.`}
        money
        max={due}
        confirmLabel={(c) => (c ? `Charge ${usd(c)} to this card` : 'Enter an amount')}
        onCancel={onBack}
        onConfirm={(c) => onCharge(c as Cents)}
      />
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <View style={{ gap: 12, alignItems: 'center' }}>
        <Text style={s.title}>Card — {usd(phase.amount)}</Text>
        <Text style={s.big}>Customer: tap, insert or swipe on the card machine</Text>
        <Text style={s.muted}>The screen updates on its own when the card machine answers.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>Card</Text>
      {paid > 0 ? <Text style={s.muted}>Paid so far {usd(paid)}</Text> : null}
      <View style={s.box}>
        <Text style={s.boxLabel}>{paid > 0 ? 'Left to pay by card' : 'Card price'}</Text>
        <Text style={s.boxValue}>{usd(due)}</Text>
        <Text style={s.muted}>or {usd(sale.remaining_cash_cents)} in cash</Text>
      </View>
      {phase.kind === 'declined' ? (
        <Text style={s.warn}>Declined{phase.message ? ` — ${phase.message}` : ''}. Try again, another card, or cash.</Text>
      ) : null}
      {phase.kind === 'error' ? <Text style={s.warn}>{phase.message ?? 'The card machine didn’t answer.'} Nothing was charged twice: trying again is safe.</Text> : null}
      <View style={s.row}>
        {phase.kind === 'error' ? (
          // Black, not red: the button carries an amount.
          <Pressable style={[s.primary, s.dark]} onPress={() => onRetry(phase.retry)}>
            <Text style={s.primaryText}>Try {usd(phase.retry.amount)} again</Text>
          </Pressable>
        ) : (
          <Pressable style={[s.primary, s.dark]} onPress={() => onCharge()}>
            <Text style={s.primaryText}>Charge {usd(due)}</Text>
          </Pressable>
        )}
      </View>
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onPartial}>
          <Text>Part on this card</Text>
        </Pressable>
        <Pressable style={s.ghost} onPress={onCash}>
          <Text>Cash instead</Text>
        </Pressable>
        <Pressable style={s.ghost} onPress={onBack}>
          <Text>Back</Text>
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
