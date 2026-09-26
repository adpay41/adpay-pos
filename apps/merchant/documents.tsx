/**
 * Documents vault (Bible 2.8; P24b): the store's licences, permits and insurance, with the date each
 * expires. AD Pay reminds the owner 30 days ahead (an alert, here and on the Alerts tab). A renewal
 * is uploaded "in place of" the old one, which stays in the history; nothing is deleted.
 *
 * In a browser any PDF, JPEG or PNG can be picked; in the phone app, a photo of the paper.
 */
import { DOCUMENT_KIND_KEYS, DOCUMENT_KINDS, DOCUMENT_MAX_BYTES, expiryStatus, daysUntil, type DocumentKind } from '@adpay/shared';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, API_URL, ApiError, upload } from './api';
import { C } from './theme';

interface Doc {
  document_id: string;
  kind: DocumentKind;
  title: string;
  location_id: string | null;
  location_name: string | null;
  expires_on: string | null;
  content_type: string;
  created_at: string;
  replaced: { document_id: string; expires_on: string | null; created_at: string }[];
}
interface Overview {
  orgs: { merchants: { locations: { location_id: string; name: string }[] }[] }[];
}

/** A file from the device: a picked file in a browser, a photo of the paper on a phone. */
async function pickFile(): Promise<Blob | null> {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,image/jpeg,image/png';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  // Keep it readable (a licence has small print) but well under the size cap.
  const ctx = ImageManipulator.manipulate(a.uri);
  if (Math.max(a.width ?? 0, a.height ?? 0) > 2000) ctx.resize(a.width >= a.height ? { width: 2000 } : { height: 2000 });
  const saved = await (await ctx.renderAsync()).saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return (await fetch(saved.uri)).blob();
}

/** Open a stored file in a new tab (browser only; the phone app says so). */
async function openDocument(token: string, id: string): Promise<void> {
  const res = await fetch(`${API_URL}/merchant/documents/${id}/file`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') throw new ApiError(0, 'Open the merchant app in a browser to view documents');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Documents({ token }: { token: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [locations, setLocations] = useState<{ location_id: string; name: string }[]>([]);
  const [form, setForm] = useState<{ replaces: Doc | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    api<{ documents: Doc[] }>('/merchant/documents', token).then(
      (r) => setDocs(r.documents),
      (e) => setMsg((e as Error).message),
    );
    api<Overview>('/merchant/overview', token).then((r) => setLocations(r.orgs.flatMap((o) => o.merchants.flatMap((m) => m.locations))), () => undefined);
  }, [token, nonce]);

  async function remove(d: Doc) {
    setMsg(null);
    try {
      await api(`/merchant/documents/${d.document_id}/remove`, token, {});
      setNonce((n) => n + 1);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      {form ? (
        <UploadForm
          token={token}
          locations={locations}
          replaces={form.replaces}
          onDone={(m) => {
            setForm(null);
            setMsg(m);
            setNonce((n) => n + 1);
          }}
          onCancel={() => setForm(null)}
        />
      ) : (
        <Pressable style={s.button} onPress={() => setForm({ replaces: null })}>
          <Text style={s.buttonText}>Add a document</Text>
        </Pressable>
      )}
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
      {docs?.length === 0 ? <Text style={s.muted}>Keep your licences, permits and insurance here. We remind you 30 days before one expires.</Text> : null}
      {docs?.map((d) => {
        const st = expiryStatus(d.expires_on, today);
        const left = d.expires_on ? daysUntil(d.expires_on, today) : null;
        return (
          <View key={d.document_id} style={s.card}>
            <View style={s.row}>
              <Text style={[s.name, { flex: 1 }]}>{d.title}</Text>
              {d.expires_on ? (
                <Text style={st === 'expired' ? s.bad : st === 'soon' ? s.warn : s.muted}>
                  {st === 'expired' ? `Expired ${d.expires_on}` : st === 'soon' ? `Expires in ${left} day${left === 1 ? '' : 's'}` : `Expires ${d.expires_on}`}
                </Text>
              ) : (
                <Text style={s.muted}>No expiry</Text>
              )}
            </View>
            <Text style={s.mutedSmall}>
              {DOCUMENT_KINDS[d.kind]}
              {d.location_name ? ` · ${d.location_name}` : ''}
              {d.replaced.length ? ` · ${d.replaced.length} earlier version${d.replaced.length === 1 ? '' : 's'}` : ''}
            </Text>
            <View style={[s.row, { flexWrap: 'wrap' }]}>
              <Pressable style={s.small} onPress={() => void openDocument(token, d.document_id).catch((e) => setMsg((e as Error).message))}>
                <Text style={s.smallText}>View</Text>
              </Pressable>
              <Pressable style={s.small} onPress={() => setForm({ replaces: d })}>
                <Text style={s.smallText}>Upload renewal</Text>
              </Pressable>
              <Pressable style={s.small} onPress={() => void remove(d)}>
                <Text style={s.smallText}>Remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function UploadForm({
  token,
  locations,
  replaces,
  onDone,
  onCancel,
}: {
  token: string;
  locations: { location_id: string; name: string }[];
  replaces: Doc | null;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<DocumentKind>(replaces?.kind ?? 'business_licence');
  const [title, setTitle] = useState(replaces?.title ?? '');
  const [expires, setExpires] = useState('');
  const [location, setLocation] = useState<string | null>(replaces?.location_id ?? (locations.length === 1 ? locations[0]!.location_id : null));
  const [file, setFile] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const expiresOk = !expires || /^\d{4}-\d{2}-\d{2}$/.test(expires);

  async function choose() {
    setError(null);
    try {
      const f = await pickFile();
      if (f && f.size > DOCUMENT_MAX_BYTES) return setError(`That file is over ${DOCUMENT_MAX_BYTES / 1_000_000} MB`);
      if (f) setFile(f);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ kind, title: title.trim() || DOCUMENT_KINDS[kind] });
    if (expires) q.set('expires_on', expires);
    if (location) q.set('location_id', location);
    if (replaces) q.set('replaces', replaces.document_id);
    try {
      await upload(`/merchant/documents?${q.toString()}`, token, file, file.type || 'image/jpeg');
      onDone(replaces ? 'Renewal saved; the old one is kept in the history.' : 'Saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.card}>
      <Text style={s.h2}>{replaces ? `Renew: ${replaces.title}` : 'Add a document'}</Text>
      {!replaces ? (
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {DOCUMENT_KIND_KEYS.map((k) => (
            <Pressable key={k} onPress={() => setKind(k)} style={[s.chip, kind === k && s.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: kind === k }}>
              <Text style={[s.chipText, kind === k && { color: '#fff' }]}>{DOCUMENT_KINDS[k]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder={DOCUMENT_KINDS[kind]} maxLength={120} />
      <TextInput style={s.input} value={expires} onChangeText={setExpires} placeholder="Expires on (YYYY-MM-DD), if it does" maxLength={10} />
      {locations.length > 1 ? (
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {[{ location_id: null as string | null, name: 'All stores' }, ...locations].map((l) => (
            <Pressable key={l.location_id ?? 'all'} onPress={() => setLocation(l.location_id)} style={[s.chip, location === l.location_id && s.chipOn]}>
              <Text style={[s.chipText, location === l.location_id && { color: '#fff' }]}>{l.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Pressable style={s.small} onPress={() => void choose()}>
        <Text style={s.smallText}>{file ? `✓ File chosen (${Math.ceil(file.size / 1000)} KB)` : Platform.OS === 'web' ? 'Choose a PDF or photo' : 'Choose a photo of it'}</Text>
      </Pressable>
      {error ? <Text style={s.bad}>{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={[s.button, { flex: 1 }, (!file || !expiresOk || busy) && { opacity: 0.5 }]} disabled={!file || !expiresOk || busy} onPress={() => void save()}>
          <Text style={s.buttonText}>{busy ? 'Uploading…' : 'Save'}</Text>
        </Pressable>
        <Pressable style={s.small} onPress={onCancel}>
          <Text style={s.smallText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  h2: { fontSize: 16, fontWeight: '800', color: C.ink },
  name: { fontWeight: '700', color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  warn: { color: '#8a5300', fontWeight: '700' },
  bad: { color: C.red, fontWeight: '700' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  small: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  smallText: { color: C.ink },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontSize: 13 },
});
