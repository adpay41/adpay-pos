/**
 * Named key pages in the merchant app (ADR 0047): the owner's own register tabs for a store, like
 * "Deli" or "Coffee", after ★ Favorites. A key is an item, or a department with a fixed amount ("$10
 * deli", "Medicine $2.00"; no amount = the cashier types it). Saved as a whole; registers pick it up
 * within seconds.
 */
import { KEY_PAGES_MAX, KeyPagesInput, PAGE_KEYS_MAX, parseUsdToCents, type CatalogSnapshot, type PageKey } from '@adpay/shared';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C, usd } from './theme';

type Draft = { name: string; keys: PageKey[] };

const moved = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

export function KeyPages({ token, catalog, locationId, onSaved }: { token: string; catalog: CatalogSnapshot; locationId: string; onSaved: (m: string) => void }) {
  const initial = useMemo<Draft[]>(() => (catalog.key_pages ?? []).map((p) => ({ name: p.name, keys: p.keys })), [catalog.key_pages]);
  const [pages, setPages] = useState<Draft[]>(initial);
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byItem = useMemo(() => new Map(catalog.items.map((i) => [i.item_id, i])), [catalog.items]);
  const byCat = useMemo(() => new Map(catalog.categories.map((c) => [c.category_id, c])), [catalog.categories]);
  const page = pages[sel] ?? null;
  const dirty = JSON.stringify(pages) !== JSON.stringify(initial);

  const update = (fn: (p: Draft) => Draft) => setPages((all) => all.map((p, i) => (i === sel ? fn(p) : p)));
  const addKey = (k: PageKey) => {
    if (!page) return;
    if (page.keys.length >= PAGE_KEYS_MAX) return setError(`A page holds up to ${PAGE_KEYS_MAX} keys`);
    setError(null);
    update((p) => ({ ...p, keys: [...p.keys, k] }));
  };
  const addPage = () => {
    if (pages.length >= KEY_PAGES_MAX) return setError(`Up to ${KEY_PAGES_MAX} pages`);
    let n = pages.length + 1;
    while (pages.some((p) => p.name.toLowerCase() === `page ${n}`)) n++;
    setPages([...pages, { name: `Page ${n}`, keys: [] }]);
    setSel(pages.length);
  };
  const addDepartment = () => {
    if (!dept) return setError('Pick a department');
    let cents: number | null = null;
    if (amount.trim()) {
      try {
        cents = parseUsdToCents(amount);
      } catch {
        return setError('Type an amount like 2.00, or leave it empty to ask each time');
      }
      if (cents <= 0) return setError('The amount must be more than $0');
    }
    addKey({ kind: 'department', category_id: dept, amount_cents: cents, label: label.trim() || null });
    setAmount('');
    setLabel('');
  };

  async function save() {
    const parsed = KeyPagesInput.safeParse({ pages });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the pages');
    setBusy(true);
    setError(null);
    try {
      await api(`/merchant/locations/${locationId}/key-pages`, token, parsed.data, 'PUT');
      onSaved(`Key pages saved (${pages.length}).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const matches = needle ? catalog.items.filter((i) => i.active && i.name.toLowerCase().includes(needle)).slice(0, 8) : [];
  const keyText = (k: PageKey) => {
    if (k.kind === 'item') {
      const it = byItem.get(k.item_id);
      return it ? `${it.name} · ${it.open_price ? 'open price' : usd(it.cash_price_cents)}` : '(removed item)';
    }
    const c = byCat.get(k.category_id);
    return `${k.label ?? c?.name ?? 'Department'} · ${c?.name ?? '?'} · ${k.amount_cents !== null ? usd(k.amount_cents) : 'any amount'}`;
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={s.card}>
        <Text style={s.h2}>Key pages</Text>
        <Text style={s.muted}>Your own tabs on the register, after ★ Favorites: a page for the deli, coffee sizes, quick amounts like "$10 deli"…</Text>
        <View style={s.chips}>
          {pages.map((p, i) => (
            <Pressable key={i} onPress={() => setSel(i)} style={[s.chip, i === sel && s.chipOn]}>
              <Text style={[s.chipText, i === sel && s.chipTextOn]}>
                {p.name} ({p.keys.length})
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={addPage} style={s.chip}>
            <Text style={s.chipText}>+ Page</Text>
          </Pressable>
        </View>
      </View>

      {page ? (
        <View style={s.card}>
          <Text style={s.label}>Page name</Text>
          <TextInput style={s.input} value={page.name} maxLength={24} onChangeText={(name) => update((p) => ({ ...p, name }))} />
          <View style={s.row}>
            <Pressable style={s.ghost} onPress={() => { setPages(moved(pages, sel, -1)); setSel(Math.max(0, sel - 1)); }}>
              <Text>← Earlier</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={() => { setPages(moved(pages, sel, 1)); setSel(Math.min(pages.length - 1, sel + 1)); }}>
              <Text>Later →</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={() => { setPages(pages.filter((_, i) => i !== sel)); setSel(0); }}>
              <Text>Delete page</Text>
            </Pressable>
          </View>

          <Text style={s.label}>Keys, in order</Text>
          {page.keys.length === 0 ? <Text style={s.muted}>No keys yet: add items or department amounts below.</Text> : null}
          {page.keys.map((k, i) => (
            <View key={i} style={s.keyRow}>
              <Text style={[s.body, { flex: 1 }]}>{keyText(k)}</Text>
              <Pressable style={s.small} onPress={() => update((p) => ({ ...p, keys: moved(p.keys, i, -1) }))} accessibilityLabel="Move up">
                <Text>↑</Text>
              </Pressable>
              <Pressable style={s.small} onPress={() => update((p) => ({ ...p, keys: moved(p.keys, i, 1) }))} accessibilityLabel="Move down">
                <Text>↓</Text>
              </Pressable>
              <Pressable style={s.small} onPress={() => update((p) => ({ ...p, keys: p.keys.filter((_, j) => j !== i) }))} accessibilityLabel="Remove">
                <Text>×</Text>
              </Pressable>
            </View>
          ))}

          <Text style={s.label}>Add an item</Text>
          <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Search your items" />
          {matches.map((i) => (
            <Pressable key={i.item_id} style={s.keyRow} onPress={() => addKey({ kind: 'item', item_id: i.item_id })}>
              <Text style={[s.body, { flex: 1 }]}>+ {i.name}</Text>
              <Text style={s.muted}>{i.open_price ? 'open price' : usd(i.cash_price_cents)}</Text>
            </Pressable>
          ))}

          <Text style={s.label}>Add a department amount</Text>
          <View style={s.chips}>
            {catalog.categories.filter((c) => c.active).map((c) => (
              <Pressable key={c.category_id} onPress={() => setDept(c.category_id)} style={[s.chip, dept === c.category_id && s.chipOn]}>
                <Text style={[s.chipText, dept === c.category_id && s.chipTextOn]}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.row}>
            <TextInput style={[s.input, { flex: 1 }]} value={amount} onChangeText={setAmount} placeholder="Amount, e.g. 2.00 (empty = ask)" keyboardType="decimal-pad" />
            <TextInput style={[s.input, { flex: 1 }]} value={label} onChangeText={setLabel} placeholder="Key label (optional)" maxLength={24} />
            <Pressable style={s.ghost} onPress={addDepartment}>
              <Text>Add</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={s.warn}>{error}</Text> : null}
      <Pressable style={[s.button, (!dirty || busy) && { opacity: 0.5 }]} disabled={!dirty || busy} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save key pages'}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  h2: { fontSize: 17, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginTop: 6 },
  body: { color: C.ink },
  muted: { color: C.muted },
  warn: { color: '#8a5300' },
  input: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, backgroundColor: '#fff' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  keyRow: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line },
  small: { borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  ghost: { borderWidth: 1, borderColor: C.black, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
