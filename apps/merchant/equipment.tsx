/**
 * Equipment and support tickets from the store (Bible 2.8; P24a): report a problem (the printer, the
 * card machine…), follow what AD Pay answered, reply, and see the equipment installed at the store.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

interface TicketRow {
  ticket_id: string;
  subject: string;
  status: 'open' | 'pending' | 'solved';
  created_at: string;
  register_name: string | null;
}
interface Note {
  note_id: string;
  author_kind: string;
  author: string | null;
  body: string;
  created_at: string;
}
interface Unit {
  unit_id: string;
  kind: string;
  model: string;
  serial: string;
  location_name: string | null;
  register_name: string | null;
  warranty_until: string | null;
}

const STATUS = { open: 'With AD Pay', pending: 'Waiting for you', solved: 'Solved' } as const;

export function Equipment({ token }: { token: string }) {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    api<{ tickets: TicketRow[] }>('/merchant/tickets', token).then((r) => setTickets(r.tickets), () => undefined);
    api<{ units: Unit[] }>('/merchant/hardware', token).then((r) => setUnits(r.units), () => undefined);
  }, [token, nonce]);

  async function report() {
    setMsg(null);
    try {
      await api('/merchant/tickets', token, { subject, body, category: 'hardware' }, 'POST');
      setSubject('');
      setBody('');
      setMsg('Sent. AD Pay answers within one business day; urgent problems, call us.');
      setNonce((n) => n + 1);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={s.card}>
        <Text style={s.h2}>Report a problem</Text>
        <TextInput style={s.input} value={subject} onChangeText={setSubject} placeholder="What's wrong? e.g. Printer won't print" maxLength={120} />
        <TextInput style={[s.input, { minHeight: 60 }]} value={body} onChangeText={setBody} placeholder="Anything that helps (which register, since when)" multiline maxLength={2000} />
        <Pressable style={[s.button, subject.trim().length < 3 && { opacity: 0.5 }]} disabled={subject.trim().length < 3} onPress={() => void report()}>
          <Text style={s.buttonText}>Send to AD Pay</Text>
        </Pressable>
        {msg ? <Text style={s.muted}>{msg}</Text> : null}
      </View>
      {tickets.map((t) => (
        <Pressable key={t.ticket_id} style={s.card} onPress={() => setOpen(open === t.ticket_id ? null : t.ticket_id)} accessibilityRole="button">
          <View style={s.row}>
            <Text style={[s.name, { flex: 1 }]}>{t.subject}</Text>
            <Text style={t.status === 'pending' ? s.warn : s.muted}>{STATUS[t.status]}</Text>
          </View>
          <Text style={s.mutedSmall}>
            {new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {t.register_name ? ` · ${t.register_name}` : ''}
          </Text>
          {open === t.ticket_id ? <Thread token={token} id={t.ticket_id} onReplied={() => setNonce((n) => n + 1)} /> : null}
        </Pressable>
      ))}
      {units.length ? (
        <View style={s.card}>
          <Text style={s.h2}>Your equipment</Text>
          {units.map((u) => (
            <Text key={u.unit_id} style={s.muted}>
              {u.kind.replace('_', ' ')} · {u.model} · {u.serial}
              {u.register_name ? ` · ${u.register_name}` : ''}
              {u.warranty_until ? ` · warranty to ${u.warranty_until}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Thread({ token, id, onReplied }: { token: string; id: string; onReplied: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [reply, setReply] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    api<{ notes: Note[] }>(`/merchant/tickets/${id}`, token).then((r) => setNotes(r.notes), () => undefined);
  }, [token, id, nonce]);
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      {notes.map((n) => (
        <View key={n.note_id} style={s.note}>
          <Text style={s.mutedSmall}>{n.author_kind === 'admin' ? 'AD Pay' : (n.author ?? 'You')}</Text>
          <Text style={s.body}>{n.body}</Text>
        </View>
      ))}
      <TextInput style={s.input} value={reply} onChangeText={setReply} placeholder="Reply" multiline />
      <Pressable
        style={[s.small, !reply.trim() && { opacity: 0.5 }]}
        disabled={!reply.trim()}
        onPress={() =>
          void api(`/merchant/tickets/${id}/notes`, token, { body: reply.trim() }, 'POST').then(() => {
            setReply('');
            setNonce((x) => x + 1);
            onReplied();
          })
        }
      >
        <Text style={s.smallText}>Send reply</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  h2: { fontSize: 16, fontWeight: '800', color: C.ink },
  name: { fontWeight: '700', color: C.ink },
  body: { color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  warn: { color: '#8a5300', fontWeight: '700' },
  note: { borderLeftWidth: 3, borderLeftColor: C.line, paddingLeft: 8 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  small: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  smallText: { color: C.ink },
});
