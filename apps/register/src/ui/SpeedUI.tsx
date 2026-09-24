/**
 * Register speed pieces (build plan P5): the number pad used for quantity and open prices, the
 * unknown-barcode form, and the price-check card. Money is typed on a cents keypad (2-0-0 → $2.00)
 * and never goes through a float.
 */
import { cents, deriveCardPrice, parseUsdToCents, sub, type CatalogCategory, type CatalogItem, type Cents } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { C, usd } from './theme';

/** Digits keypad. `money` fills from the cents column; otherwise it's a whole number (quantity). */
export function NumberPad({
  title,
  subtitle,
  money,
  initial,
  confirmLabel,
  max,
  allowZero = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  subtitle?: string;
  money: boolean;
  initial?: number;
  confirmLabel: (value: number) => string;
  max: number;
  /** Quantity 0 = remove the line. */
  allowZero?: boolean;
  onConfirm: (value: number) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState(initial ? String(initial) : '');
  const value = digits ? Number(digits) : 0;
  const ok = value > 0 || (allowZero && digits !== '');
  const press = (k: string) =>
    setDigits((d) => {
      const next = k === '⌫' ? d.slice(0, -1) : (d + k).replace(/^0+(?=\d)/, '');
      return Number(next || '0') > max ? d : next;
    });
  return (
    <>
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.muted}>{subtitle}</Text> : null}
      <Text style={s.value}>{money ? usd(value) : value}</Text>
      <View style={s.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', money ? '00' : 'C', '0', '⌫'].map((k) => (
          <Pressable key={k} style={s.key} onPress={() => (k === 'C' ? setDigits('') : press(k))} accessibilityLabel={k === '⌫' ? 'Delete' : k}>
            <Text style={s.keyText}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>Back</Text>
        </Pressable>
        <Pressable style={[s.primary, !ok && s.disabled]} disabled={!ok} onPress={() => onConfirm(value)}>
          <Text style={s.primaryText}>{confirmLabel(value)}</Text>
        </Pressable>
      </View>
    </>
  );
}

/**
 * Unknown barcode → one screen: name, price, category, done (Bible 1.1). The item is in the
 * catalog from this moment, sellable offline, and syncs to every register.
 */
export function UnknownItemForm({
  code,
  categories,
  dualRatePpm,
  onCreate,
  onCancel,
}: {
  code: string;
  categories: CatalogCategory[];
  dualRatePpm: number;
  onCreate: (v: { name: string; cash: Cents; category_id: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState<string | null>(categories[0]?.category_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const cash: Cents | null = (() => {
    try {
      return price.trim() ? parseUsdToCents(price) : null;
    } catch {
      return null;
    }
  })();
  const submit = () => {
    if (!name.trim()) return setError('Type what it is');
    if (cash === null || cash <= 0) return setError('Type a price like 3.49');
    onCreate({ name: name.trim(), cash, category_id: category });
  };
  return (
    <>
      <Text style={s.title}>New item</Text>
      <Text style={s.muted}>
        Barcode <Text style={s.mono}>{code}</Text> isn’t in the catalog yet. Add it once, and it rings up on every register from now on.
      </Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="What is it? e.g. Goya Adobo 8oz" autoFocus maxLength={120} />
      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1 }]} value={price} onChangeText={setPrice} placeholder="Cash price, e.g. 3.49" keyboardType="decimal-pad" onSubmitEditing={submit} />
        <View style={{ justifyContent: 'center' }}>
          <Text style={s.muted}>{cash ? `card ${usd(deriveCardPrice(cash, dualRatePpm))}` : ' '}</Text>
        </View>
      </View>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {categories.map((c) => (
          <Pressable key={c.category_id} onPress={() => setCategory(c.category_id)} style={[s.chip, category === c.category_id && s.chipOn]}>
            <Text style={[s.chipText, category === c.category_id && { color: '#fff' }]}>
              {c.name}
              {c.min_age ? ` ${c.min_age}+` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>Cancel</Text>
        </Pressable>
        <Pressable style={s.primary} onPress={submit}>
          <Text style={s.primaryText}>Add & ring up</Text>
        </Pressable>
      </View>
    </>
  );
}

/** Price check: scan without ringing (Bible 1.9). Cost and margin only for people allowed to see them. */
export function PriceCheckCard({ item, showCost, onShowCost, onDone }: { item: CatalogItem; showCost: boolean; onShowCost: () => void; onDone: () => void }) {
  const margin =
    item.cost_cents !== null && item.cash_price_cents > 0
      ? Math.trunc((sub(cents(item.cash_price_cents), cents(item.cost_cents)) * 1000) / item.cash_price_cents) / 10
      : null;
  return (
    <>
      <Text style={s.muted}>Price check — not rung up</Text>
      <Text style={s.title}>{item.name}</Text>
      <View style={s.row}>
        <View style={s.box}>
          <Text style={s.boxLabel}>Cash</Text>
          <Text style={s.boxValue}>{item.open_price ? 'open' : usd(item.cash_price_cents)}</Text>
        </View>
        <View style={s.box}>
          <Text style={s.boxLabel}>Card</Text>
          <Text style={s.boxValue}>{item.open_price ? 'open' : usd(item.card_price_cents)}</Text>
        </View>
      </View>
      {showCost ? (
        <Text style={s.body}>
          {item.cost_cents === null ? 'No cost entered for this item.' : `Cost ${usd(item.cost_cents)} · margin ${margin}%`}
        </Text>
      ) : (
        <Pressable style={s.ghost} onPress={onShowCost}>
          <Text>Show cost and margin</Text>
        </Pressable>
      )}
      <Pressable style={s.primary} onPress={onDone}>
        <Text style={s.primaryText}>Done</Text>
      </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  body: { fontSize: 16, color: C.ink },
  muted: { color: C.muted },
  mono: { fontFamily: 'monospace', color: C.ink },
  value: { fontSize: 32, fontWeight: '800', color: C.black, textAlign: 'right', fontVariant: ['tabular-nums'] },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  key: { width: '31%', flexGrow: 1, backgroundColor: C.ground, borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  keyText: { fontSize: 22, fontWeight: '700', color: C.ink },
  row: { flexDirection: 'row', gap: 8 },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  primary: { flexGrow: 1, backgroundColor: C.red, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 18 },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '600' },
  error: { color: C.amber, fontWeight: '700' },
  box: { flex: 1, backgroundColor: C.ground, borderRadius: 8, padding: 12 },
  boxLabel: { fontSize: 12, color: C.muted, fontWeight: '700' },
  boxValue: { fontSize: 28, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
});
