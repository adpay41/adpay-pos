/**
 * Ticket (basket) discount on the register (ADR 0048): a percent or an amount off the whole ticket,
 * with a reason. Applying it needs `ticket.discount` (a manager's PIN for a cashier); the reason and
 * who applied it are on the event. The amount can come from what's typed on the pad.
 */
import { cents, type BasketDiscount, type CashierKey, type FoldedSale } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tk, useT } from './i18n';
import { C, usd } from './theme';

const PERCENTS = [5, 10, 15, 20];
const REASONS: CashierKey[] = [tk('Regular customer'), tk('Damaged item'), tk('Price match'), tk('Manager’s call')];

export function BasketPanel({
  sale,
  typedCents,
  onApply,
  onRemove,
  onCancel,
}: {
  sale: FoldedSale;
  /** What's on the pad, offered as "$x off". */
  typedCents: number;
  onApply: (d: BasketDiscount) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<{ kind: 'percent'; pct: number } | { kind: 'amount'; cents: number } | null>(null);
  const [reason, setReason] = useState<CashierKey | null>(null);
  const goods = sale.lines.filter((l) => !l.is_fee).reduce((n, l) => n + l.unit_cash_price_cents * l.qty - l.cash_discount_cents, 0);
  const off = choice ? (choice.kind === 'percent' ? Math.floor((goods * choice.pct + 50) / 100) : Math.min(choice.cents, goods)) : 0;

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>{t('Discount the whole ticket')}</Text>
      {sale.basket ? (
        <Text style={s.muted}>
          {t('Now: {amount} off', { amount: usd(sale.basket.cash_cents) })}
          {sale.basket.reason ? ` · ${sale.basket.reason}` : ''}
        </Text>
      ) : null}
      <View style={s.row}>
        {PERCENTS.map((p) => (
          <Pressable key={p} style={[s.chip, choice?.kind === 'percent' && choice.pct === p && s.chipOn]} onPress={() => setChoice({ kind: 'percent', pct: p })}>
            <Text style={[s.chipText, choice?.kind === 'percent' && choice.pct === p && s.chipTextOn]}>{p}%</Text>
          </Pressable>
        ))}
        {typedCents > 0 ? (
          <Pressable style={[s.chip, choice?.kind === 'amount' && s.chipOn]} onPress={() => setChoice({ kind: 'amount', cents: typedCents })}>
            <Text style={[s.chipText, choice?.kind === 'amount' && s.chipTextOn]}>{t('{amount} off', { amount: usd(typedCents) })}</Text>
          </Pressable>
        ) : (
          <Text style={s.muted}>{t('For an amount off, type it on the pad first.')}</Text>
        )}
      </View>
      <Text style={s.label}>{t('Why')}</Text>
      <View style={s.row}>
        {REASONS.map((r) => (
          <Pressable key={r} style={[s.chip, reason === r && s.chipOn]} onPress={() => setReason(r)}>
            <Text style={[s.chipText, reason === r && s.chipTextOn]}>{t(r)}</Text>
          </Pressable>
        ))}
      </View>
      {choice ? <Text style={s.body}>{t('Takes {amount} off the cash price (card price in proportion).', { amount: usd(cents(off)) })}</Text> : null}
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>{t('Back')}</Text>
        </Pressable>
        {sale.basket ? (
          <Pressable style={s.ghost} onPress={onRemove}>
            <Text>{t('Remove the discount')}</Text>
          </Pressable>
        ) : null}
        {/* Black, not red: it carries an amount. */}
        <Pressable
          style={[s.primary, (!choice || !reason) && s.disabled]}
          disabled={!choice || !reason}
          onPress={() =>
            choice &&
            reason &&
            onApply(
              choice.kind === 'percent'
                ? { kind: 'percent', percent_ppm: choice.pct * 10_000, amount_cents: null, reason }
                : { kind: 'amount', percent_ppm: null, amount_cents: choice.cents, reason },
            )
          }
        >
          <Text style={s.primaryText}>{choice ? t('Take {amount} off', { amount: usd(cents(off)) }) : t('Pick a discount')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, fontWeight: '700', textTransform: 'uppercase' },
  body: { color: C.ink },
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
