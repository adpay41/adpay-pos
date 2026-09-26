/**
 * The customer types their mobile number on the customer screen (P19a): for rewards, or to get the
 * receipt by text. Rewards can carry an opt-in to the store's texts, with the consent sentence the
 * server stores word for word. The consent is in English: its wording is the legal record (ADR 0029).
 */
import { normalizeUsPhone, textConsent, type Translate } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from './theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'] as const;

export function formatPhone(d: string): string {
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

export function PhonePad({
  t,
  title,
  askConsent,
  storeName,
  big,
  onDone,
  onCancel,
}: {
  t: Translate;
  title: string;
  askConsent: boolean;
  storeName: string;
  big: boolean;
  onDone: (phone: string, optIn: boolean) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [error, setError] = useState(false);
  const k = big ? 1.3 : 1;
  const press = (key: (typeof KEYS)[number]) => {
    setError(false);
    if (key === '⌫') return setDigits((d) => d.slice(0, -1));
    if (key === '✓') {
      if (!normalizeUsPhone(digits)) return setError(true);
      return onDone(digits, optIn);
    }
    setDigits((d) => (d + key).slice(0, 10));
  };
  return (
    <View style={s.wrap}>
      <Text style={[s.title, { fontSize: 26 * k }]} accessibilityRole="header">
        {title}
      </Text>
      <Text style={[s.number, { fontSize: 40 * k }]} accessibilityLiveRegion="polite">
        {formatPhone(digits) || ' '}
      </Text>
      {error ? <Text style={[s.error, { fontSize: 16 * k }]}>{t('phone_invalid')}</Text> : null}
      <View style={[s.keys, { width: 300 * k }]}>
        {KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => press(key)}
            style={[s.key, { width: 92 * k, height: 64 * k }, key === '✓' && s.done]}
            accessibilityRole="button"
            accessibilityLabel={key === '⌫' ? 'Delete' : key === '✓' ? t('ok') : key}
          >
            <Text style={[s.keyText, { fontSize: 26 * k }, key === '✓' && { color: '#fff' }]}>{key}</Text>
          </Pressable>
        ))}
      </View>
      {askConsent ? (
        <Pressable onPress={() => setOptIn(!optIn)} style={s.consent} accessibilityRole="checkbox" accessibilityState={{ checked: optIn }}>
          <View style={[s.box, optIn && s.boxOn]}>{optIn ? <Text style={s.tick}>✓</Text> : null}</View>
          <Text style={[s.consentText, { fontSize: 13 * k }]}>
            {textConsent(storeName)}
          </Text>
        </Pressable>
      ) : null}
      <Pressable onPress={onCancel} style={s.cancel} accessibilityRole="button">
        <Text style={[s.cancelText, { fontSize: 16 * k }]}>{t('cancel')}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20, backgroundColor: '#fff' },
  title: { fontWeight: '800', color: C.ink, textAlign: 'center' },
  number: { fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'], minHeight: 50 },
  error: { color: C.amber, fontWeight: '700' },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  key: { borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  done: { backgroundColor: C.black, borderColor: C.black },
  keyText: { fontWeight: '700', color: C.ink },
  consent: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', maxWidth: 520, marginTop: 6 },
  box: { width: 24, height: 24, borderRadius: 4, borderWidth: 2, borderColor: C.black, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: C.black },
  tick: { color: '#fff', fontWeight: '800' },
  consentText: { flex: 1, color: C.ink },
  cancel: { padding: 10 },
  cancelText: { color: C.muted, fontWeight: '600' },
});
