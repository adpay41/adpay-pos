/**
 * Opening and closing checklists in the merchant app (Bible 2.8; P24c, ADR 0038): each store's last
 * seven days — who opened and closed, what was ticked, the photos — and the lists themselves, which
 * reach the registers on their next sync.
 */
import { CHECKLIST_KINDS, CHECKLIST_LABELS, CHECKLIST_MAX_ITEMS, ChecklistsInput, type ChecklistKind, type Checklists, type ChecklistSummary } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, apiUrl } from './api';
import { C } from './theme';

interface Run {
  event_id: string;
  kind: ChecklistKind;
  register_name: string;
  at: string;
  by: string | null;
  items: { item_id: string; label: string; photo_required: boolean; done: boolean; photo_url: string | null }[];
  note: string | null;
  summary: ChecklistSummary;
}
interface Day {
  location_id: string;
  location_name: string;
  business_date: string;
  open: Run | null;
  close: Run | null;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ChecklistsCard({ token }: { token: string }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [open, setOpen] = useState<Run | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 86_400_000);
    api<{ days: Day[] }>(`/merchant/checklists/report?from=${ymd(from)}&to=${ymd(to)}`, token).then(
      (r) => setDays(r.days),
      (e) => setError((e as Error).message),
    );
  }, [token]);

  const multi = new Set(days?.map((d) => d.location_id)).size > 1;
  const cell = (r: Run | null) =>
    r ? (
      <Pressable onPress={() => setOpen(open?.event_id === r.event_id ? null : r)} style={{ flex: 1 }} accessibilityRole="button">
        <Text style={r.summary.complete ? s.ok : s.warn}>
          {r.summary.done}/{r.summary.total}
          {r.summary.missing_photos ? ` · ${r.summary.missing_photos} photo${r.summary.missing_photos === 1 ? '' : 's'} missing` : ''}
        </Text>
        <Text style={s.mutedSmall}>
          {new Date(r.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          {r.by ? ` · ${r.by}` : ''}
        </Text>
      </Pressable>
    ) : (
      <Text style={[s.muted, { flex: 1 }]}>not done</Text>
    );

  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={[s.h2, { flex: 1 }]}>Open & close checklists</Text>
        <Pressable style={s.small} onPress={() => setEditing((v) => !v)}>
          <Text style={s.smallText}>{editing ? 'Close editor' : 'Edit lists'}</Text>
        </Pressable>
      </View>
      {editing ? <Editor token={token} onSaved={() => setEditing(false)} /> : null}
      {error ? <Text style={s.muted}>{error}</Text> : null}
      <View style={s.row}>
        <Text style={[s.mutedSmall, { width: 92 }]}>Day</Text>
        <Text style={[s.mutedSmall, { flex: 1 }]}>Opening</Text>
        <Text style={[s.mutedSmall, { flex: 1 }]}>Closing</Text>
      </View>
      {days?.map((d) => (
        <View key={`${d.location_id}:${d.business_date}`}>
          <View style={[s.row, s.line]}>
            <Text style={{ width: 92, color: C.ink }}>
              {new Date(`${d.business_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {multi ? `\n${d.location_name}` : ''}
            </Text>
            {cell(d.open)}
            {cell(d.close)}
          </View>
          {open && (open.event_id === d.open?.event_id || open.event_id === d.close?.event_id) ? <RunDetail r={open} /> : null}
        </View>
      ))}
    </View>
  );
}

function RunDetail({ r }: { r: Run }) {
  return (
    <View style={{ gap: 6, paddingVertical: 6 }}>
      <Text style={s.mutedSmall}>
        {CHECKLIST_LABELS[r.kind]} · {r.register_name}
      </Text>
      {r.items.map((i) => (
        <View key={i.item_id} style={s.row}>
          <Text style={i.done ? s.ok : s.warn}>{i.done ? '✓' : '✗'}</Text>
          <Text style={{ flex: 1, color: C.ink }}>{i.label}</Text>
          {i.photo_url ? (
            <Image source={{ uri: apiUrl(i.photo_url) }} style={{ width: 72, height: 54, borderRadius: 4 }} accessibilityLabel={`Photo: ${i.label}`} />
          ) : i.photo_required ? (
            <Text style={s.warn}>no photo</Text>
          ) : null}
        </View>
      ))}
      {r.note ? <Text style={s.muted}>“{r.note}”</Text> : null}
    </View>
  );
}

function Editor({ token, onSaved }: { token: string; onSaved: () => void }) {
  const [lists, setLists] = useState<Checklists | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ lists: Checklists }>('/merchant/checklists', token).then(
      (r) => setLists(r.lists),
      (e) => setError((e as Error).message),
    );
  }, [token]);
  if (!lists) return error ? <Text style={s.muted}>{error}</Text> : null;

  const update = (k: ChecklistKind, fn: (items: Checklists[ChecklistKind]) => Checklists[ChecklistKind]) => setLists({ ...lists, [k]: fn(lists[k]) });
  const parsed = ChecklistsInput.safeParse(lists);

  async function save() {
    setError(null);
    try {
      await api('/merchant/checklists', token, lists, 'PUT');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      {CHECKLIST_KINDS.map((k) => (
        <View key={k} style={{ gap: 6 }}>
          <Text style={s.name}>{CHECKLIST_LABELS[k]}</Text>
          {lists[k].map((item, n) => (
            <View key={item.id} style={s.row}>
              <TextInput style={[s.input, { flex: 1 }]} value={item.label} onChangeText={(v) => update(k, (xs) => xs.map((x, j) => (j === n ? { ...x, label: v } : x)))} maxLength={80} />
              <Text style={s.mutedSmall}>photo</Text>
              <Switch value={item.photo} onValueChange={(v) => update(k, (xs) => xs.map((x, j) => (j === n ? { ...x, photo: v } : x)))} />
              <Pressable style={s.small} onPress={() => update(k, (xs) => xs.filter((_, j) => j !== n))} accessibilityLabel={`Remove ${item.label}`}>
                <Text style={s.smallText}>✕</Text>
              </Pressable>
            </View>
          ))}
          {lists[k].length < CHECKLIST_MAX_ITEMS ? (
            <Pressable style={s.small} onPress={() => update(k, (xs) => [...xs, { id: `${k}-${Date.now().toString(36)}`, label: '', photo: false }])}>
              <Text style={s.smallText}>+ Add item</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {error ? <Text style={s.warn}>{error}</Text> : null}
      {!parsed.success ? <Text style={s.mutedSmall}>Each item needs at least 2 characters.</Text> : null}
      <Pressable style={[s.button, !parsed.success && { opacity: 0.5 }]} disabled={!parsed.success} onPress={() => void save()}>
        <Text style={s.buttonText}>Save lists (registers pick them up at their next sync)</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line },
  h2: { fontSize: 16, fontWeight: '800', color: C.ink },
  name: { fontWeight: '700', color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  ok: { color: C.ink, fontWeight: '700' },
  warn: { color: '#8a5300', fontWeight: '700' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 8, fontSize: 15 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
  small: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  smallText: { color: C.ink },
});
