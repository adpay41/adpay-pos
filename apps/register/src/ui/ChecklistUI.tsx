/**
 * Opening and closing checklists at the register (Bible 2.8; P24c, ADR 0038). The owner's lists come
 * in the snapshot; the cashier ticks each item, takes a photo where the item asks for one (online
 * only: offline, the item can still be ticked and the photo shows as missing to the owner), and
 * saves. One `checklist.completed` event records everything as ticked, unticked items included.
 */
import { CHECKLIST_KINDS, checklistsOf, type ChecklistKind, type ChecklistResultItem, type CatalogSnapshot } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Runtime } from '../runtime';
import { takeCountPhoto } from './countPhoto';
import { tk, useT } from './i18n';
import { C } from './theme';

const TITLE: Record<ChecklistKind, ReturnType<typeof tk>> = { open: tk('Opening checklist'), close: tk('Closing checklist') };

export function ChecklistPanel({
  rt,
  catalog,
  uploadPhoto,
  onDone,
}: {
  rt: Runtime;
  catalog: CatalogSnapshot;
  /** Null when offline: photos can't be sent, the rest still works. */
  uploadPhoto: ((blob: Blob) => Promise<string>) | null;
  onDone: (message: string | null) => void;
}) {
  const t = useT();
  const lists = checklistsOf(catalog.checklists);
  // Before noon it's most likely opening time; the cashier can switch.
  const [kind, setKind] = useState<ChecklistKind>(new Date().getHours() < 12 ? 'open' : 'close');
  const [state, setState] = useState<Record<string, { done: boolean; photo: string | null; busy: boolean }>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const items = lists[kind];
  const at = (id: string) => state[id] ?? { done: false, photo: null, busy: false };
  const set = (id: string, v: Partial<{ done: boolean; photo: string | null; busy: boolean }>) => setState((p) => ({ ...p, [id]: { ...at(id), ...(p[id] ?? {}), ...v } }));

  async function snap(id: string) {
    if (!uploadPhoto) return;
    setError(null);
    set(id, { busy: true });
    try {
      const blob = await takeCountPhoto();
      if (!blob) return set(id, { busy: false });
      const mediaId = await uploadPhoto(blob);
      set(id, { busy: false, photo: mediaId, done: true });
    } catch (e) {
      set(id, { busy: false });
      setError(t('No photo: {error}', { error: (e as Error).message }));
    }
  }

  async function save() {
    setError(null);
    const result: ChecklistResultItem[] = items.map((i) => ({ item_id: i.id, label: i.label, photo_required: i.photo, done: at(i.id).done, photo_media_id: at(i.id).photo }));
    try {
      await rt.session.recordChecklist({ checklist_id: rt.uuid(), kind, items: result, note: note.trim() || null });
      const done = result.filter((r) => r.done).length;
      onDone(done === result.length ? null : t('{title} saved: {done} of {total} done.', { title: t(TITLE[kind]), done, total: result.length }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <View style={{ gap: 10, minWidth: 420, maxWidth: 560 }}>
      <View style={s.chips}>
        {CHECKLIST_KINDS.map((k) => (
          <Pressable key={k} onPress={() => setKind(k)} style={[s.chip, kind === k && s.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: kind === k }}>
            <Text style={kind === k ? { color: '#fff', fontWeight: '700' } : undefined}>{t(TITLE[k])}</Text>
          </Pressable>
        ))}
      </View>
      {items.length === 0 ? <Text style={s.muted}>{t('No items on this list yet. The owner adds them in the merchant app (Hours).')}</Text> : null}
      <ScrollView style={{ maxHeight: 420 }}>
        {items.map((i) => {
          const st = at(i.id);
          return (
            <View key={i.id} style={s.line}>
              <Pressable style={[s.box, st.done && s.boxOn]} onPress={() => set(i.id, { done: !st.done })} accessibilityRole="checkbox" accessibilityState={{ checked: st.done }} accessibilityLabel={i.label}>
                <Text style={{ color: '#fff', fontWeight: '800' }}>{st.done ? '✓' : ''}</Text>
              </Pressable>
              <Text style={{ flex: 1, color: C.ink, fontSize: 16 }}>{i.label}</Text>
              {i.photo ? (
                uploadPhoto ? (
                  <Pressable style={s.ghost} onPress={() => void snap(i.id)} disabled={st.busy}>
                    <Text>{st.busy ? t('Uploading…') : st.photo ? t('✓ Photo') : t('Photo')}</Text>
                  </Pressable>
                ) : (
                  <Text style={s.warn}>{t('Photo when online')}</Text>
                )
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <TextInput style={s.input} value={note} onChangeText={setNote} placeholder={t('Note for the owner (optional)')} maxLength={300} />
      {error ? <Text style={s.warn}>{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={() => onDone(null)}>
          <Text>{t('Cancel')}</Text>
        </Pressable>
        <Pressable style={[s.primary, !items.length && { opacity: 0.5 }]} disabled={!items.length} onPress={() => void save()}>
          <Text style={s.primaryText}>{t('Save checklist')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  muted: { color: C.muted },
  warn: { color: C.amber, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16, backgroundColor: '#fff' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  box: { width: 34, height: 34, borderRadius: 8, borderWidth: 2, borderColor: C.black, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  boxOn: { backgroundColor: C.black },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'flex-end' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  ghost: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#fff' },
  primary: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  primaryText: { color: '#fff', fontWeight: '700' },
});
