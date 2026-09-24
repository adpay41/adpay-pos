/**
 * Receipt settings from the phone (build plan P8, Bible 1.6): header lines, return policy, footer,
 * a QR link, and what happens after a cash sale, with a live preview printed by the same shared
 * renderer the register uses. The store logo is uploaded in admin (it needs a desktop image).
 */
import { ReceiptSettingsInput, renderReceipt, sampleReceiptSale, type CatalogSnapshot } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

interface Loc {
  location_id: string;
  name: string;
  state: string | null;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

const AFTER = [
  ['ask', 'Ask each time'],
  ['print', 'Always print'],
  ['none', 'No receipt unless asked (fastest)'],
] as const;

export function ReceiptEditor({ token, catalog, location, onSaved }: { token: string; catalog: CatalogSnapshot; location: Loc; onSaved: (m: string) => void }) {
  const cur = catalog.receipt;
  const [header, setHeader] = useState(cur?.header_lines.join('\n') ?? '');
  const [policy, setPolicy] = useState(cur?.return_policy ?? '');
  const [footer, setFooter] = useState(cur?.footer ?? 'Thank you!');
  const [qr, setQr] = useState(cur?.qr?.url ?? '');
  const [after, setAfter] = useState<'ask' | 'print' | 'none'>(cur?.after_sale ?? 'ask');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = ReceiptSettingsInput.safeParse({
    header_lines: header.split('\n').map((l) => l.trim()).filter(Boolean),
    logo_media_id: cur?.logo_media_id ?? null,
    return_policy: policy.trim() || null,
    footer: footer.trim() || 'Thank you!',
    qr: qr.trim() ? { kind: 'link', url: qr.trim(), caption: cur?.qr?.caption ?? 'Scan me' } : null,
    after_sale: after,
  });
  const preview = useMemo(
    () =>
      parsed.success
        ? renderReceipt({
            header: { merchant_name: 'Your store', location_name: location.name, address_line1: null, city_state_zip: location.state, register_name: 'Register 1' },
            sale: sampleReceiptSale(location.tax_rate_ppm, location.dual_price_rate_ppm),
            occurred_at: '2026-09-23T12:15:00.000Z',
            timezone: 'America/New_York',
            copy: 'original',
            settings: parsed.data,
            logo_url: null,
          })
        : null,
    [parsed, location],
  );

  async function save() {
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the fields');
    setBusy(true);
    setError(null);
    try {
      await api(`/merchant/locations/${location.location_id}/receipt`, token, parsed.data, 'PUT');
      onSaved(`Receipt saved for ${location.name}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={s.label}>After a cash sale</Text>
      <View style={s.card}>
        {AFTER.map(([v, label]) => (
          <Pressable key={v} onPress={() => setAfter(v)} style={s.radioRow} accessibilityRole="radio" accessibilityState={{ checked: after === v }}>
            <View style={[s.radio, after === v && s.radioOn]} />
            <Text style={s.body}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>Header lines (phone, Instagram, hours)</Text>
      <TextInput style={[s.input, { minHeight: 70 }]} value={header} onChangeText={setHeader} multiline placeholder={'(201) 555-0100\n@yourstore'} />
      <Text style={s.label}>Return policy</Text>
      <TextInput style={[s.input, { minHeight: 60 }]} value={policy} onChangeText={setPolicy} multiline maxLength={240} placeholder="Leave empty for none" />
      <Text style={s.label}>Footer</Text>
      <TextInput style={s.input} value={footer} onChangeText={setFooter} maxLength={96} />
      <Text style={s.label}>QR code link (optional — e.g. your Google review page)</Text>
      <TextInput style={s.input} value={qr} onChangeText={setQr} autoCapitalize="none" autoCorrect={false} placeholder="https://…" />
      {error || !parsed.success ? <Text style={s.error}>{error ?? parsed.error?.issues[0]?.message}</Text> : null}
      <Pressable style={[s.button, (busy || !parsed.success) && { opacity: 0.5 }]} disabled={busy || !parsed.success} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save receipt'}</Text>
      </Pressable>
      <Text style={s.label}>Preview</Text>
      <View style={s.paper}>
        {preview?.map((l, i) =>
          l.style === 'qr' ? (
            <Text key={i} style={[s.paperLine, { textAlign: 'center', fontWeight: '800' }]}>
              ▣ QR
            </Text>
          ) : l.style === 'logo' ? null : (
            <Text key={i} style={[s.paperLine, (l.style === 'bold' || l.style === 'double') && { fontWeight: '800' }]}>
              {l.text || ' '}
            </Text>
          ),
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 10, gap: 4 },
  body: { color: C.ink },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted },
  radioOn: { borderColor: C.black, backgroundColor: C.black },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  error: { color: C.red },
  button: { backgroundColor: C.red, borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  paper: { backgroundColor: '#fffef8', borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 10 },
  paperLine: { fontFamily: Platform.select({ web: 'ui-monospace, Consolas, monospace', default: 'monospace' }), fontSize: 9.5, color: '#222' },
});
