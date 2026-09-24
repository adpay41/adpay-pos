/**
 * Help: a text chat with AD Pay support (build plan P12b, Bible 2.8 L40). One conversation per
 * store; replies arrive live over `/ws`. "Share my screen from the register" waits for the device
 * management vendor (open decision), so it isn't offered yet.
 */
import type { SupportMessage } from '@adpay/shared';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { useRealtime } from './live';
import { C } from './theme';

export function SupportTab({ token }: { token: string }) {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    api<{ messages: SupportMessage[] }>('/merchant/support', token).then((r) => setMessages(r.messages), (e) => setError((e as Error).message));
  }, [token]);
  useRealtime(token, (m) => {
    if (m.type !== 'support') return;
    setMessages((prev) => (prev && !prev.some((x) => x.message_id === m.message.message_id) ? [...prev, m.message] : prev));
  });
  useEffect(() => {
    scroll.current?.scrollToEnd({ animated: true });
  }, [messages?.length]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api<SupportMessage>('/merchant/support', token, { body });
      setMessages((prev) => (prev && !prev.some((x) => x.message_id === m.message_id) ? [...prev, m] : prev));
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!messages) return error ? <Text style={[s.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} />;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scroll} contentContainerStyle={s.page}>
        <Text style={s.muted}>Write to AD Pay support. We answer here; you’ll see the reply as soon as it’s sent.</Text>
        {messages.map((m) => {
          const mine = m.author_kind === 'merchant_user';
          return (
            <View key={m.message_id} style={[s.bubble, mine ? s.mine : s.theirs]}>
              <Text style={[s.body, mine && { color: '#fff' }]}>{m.body}</Text>
              <Text style={[s.meta, mine && { color: '#ddd' }]}>
                {mine ? (m.author_name ?? 'You') : 'AD Pay support'} · {new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </Text>
            </View>
          );
        })}
      </ScrollView>
      {error ? <Text style={[s.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
      <View style={s.composer}>
        <TextInput style={s.input} value={draft} onChangeText={setDraft} placeholder="Type a message" multiline maxLength={2000} />
        <Pressable onPress={() => void send()} disabled={busy || !draft.trim()} style={[s.send, (busy || !draft.trim()) && { opacity: 0.5 }]}>
          <Text style={s.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 8, maxWidth: 640, width: '100%', alignSelf: 'center' },
  muted: { color: C.muted, marginBottom: 4 },
  error: { color: C.red },
  bubble: { maxWidth: '82%', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: C.black },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  body: { color: C.ink },
  meta: { color: C.muted, fontSize: 11 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: '#fff' },
  input: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, maxHeight: 120, color: C.ink },
  send: { backgroundColor: C.black, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  sendText: { color: '#fff', fontWeight: '700' },
});
