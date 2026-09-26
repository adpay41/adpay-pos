/**
 * Send a receipt later, by text or email (Bible 1.6, P18b). The message carries the digital-receipt
 * link. Until a text/email provider is connected the API records the message but delivers nothing,
 * and this says so plainly.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

export function SendReceipt({ token, saleId }: { token: string; saleId: string }) {
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ status: string; delivered: boolean; to: string; url: string }>(`/merchant/sales/${saleId}/send-receipt`, token, { channel, to }, 'POST');
      setResult(
        r.delivered
          ? { ok: true, text: `Sent to ${r.to}.` }
          : { ok: true, text: `Recorded for ${r.to}, but not delivered: texting and email aren’t connected yet. The customer can use this link:`, url: r.url },
      );
      setTo('');
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.box}>
      <View style={s.row}>
        {(['sms', 'email'] as const).map((c) => (
          <Pressable key={c} onPress={() => setChannel(c)} style={[s.chip, channel === c && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: channel === c }}>
            <Text style={[s.chipText, channel === c && s.chipTextOn]}>{c === 'sms' ? 'Text' : 'Email'}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.row}>
        <TextInput
          style={s.input}
          value={to}
          onChangeText={setTo}
          placeholder={channel === 'sms' ? 'Customer’s mobile number' : 'Customer’s email'}
          keyboardType={channel === 'sms' ? 'phone-pad' : 'email-address'}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={channel === 'sms' ? 'Customer’s mobile number' : 'Customer’s email'}
        />
        <Pressable style={[s.button, (busy || to.trim().length < 3) && { opacity: 0.5 }]} disabled={busy || to.trim().length < 3} onPress={() => void send()}>
          <Text style={s.buttonText}>{busy ? 'Sending…' : 'Send receipt'}</Text>
        </Pressable>
      </View>
      {result ? (
        <Text style={result.ok ? s.note : s.error} selectable>
          {result.text}
          {result.url ? `\n${result.url}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 8, paddingTop: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  input: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 14 },
  buttonText: { color: '#fff', fontWeight: '700' },
  note: { color: C.muted },
  error: { color: '#8a5300' },
});
