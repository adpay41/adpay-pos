/**
 * Shelf tags and labels (Bible 1.6, 2.3, 3.4; P21): the tags to reprint after price changes, tags for
 * a whole category, price labels for the deli's open-price items, and label templates. Everything
 * comes out as a PDF: an Avery 5160 sheet for any office printer, or thermal labels for a label
 * printer (its driver prints the PDF; a direct printer connection isn't built).
 */
import { cents, formatUsd, LABEL_SIZES, LabelTemplateInput, parseUsdToCents, type CatalogSnapshot, type LabelSize } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, openPdf } from './api';
import { C } from './theme';

const usd = (v: number) => formatUsd(cents(v));
interface Template {
  template_id: string | null;
  settings: LabelTemplateInput;
}
interface QueueItem {
  item_id: string;
  name: string;
  cash_price_cents: number;
  card_price_cents: number;
  printed_cash_cents: number | null;
}

export function Labels({ token, catalog, locationId }: { token: string; catalog: CatalogSnapshot; locationId: string }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api<{ templates: Template[] }>('/merchant/labels/templates', token).then((r) => setTemplates(r.templates), () => undefined);
    api<{ items: QueueItem[] }>(`/merchant/labels/queue?location_id=${locationId}`, token).then((r) => setQueue(r.items), (e: Error) => setMsg(e.message));
  }, [token, locationId, nonce]);

  async function print(itemIds: string[]) {
    setMsg(null);
    try {
      await openPdf('/merchant/labels/shelf-tags.pdf', token, { item_ids: itemIds, location_id: locationId, template_id: templateId });
      setMsg(`${itemIds.length} tags ready to print.`);
      setNonce((n) => n + 1);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const current = templates.find((t) => t.template_id === templateId)?.settings;
  return (
    <View style={{ gap: 10 }}>
      <View style={s.card}>
        <Text style={s.h2}>Shelf tags</Text>
        <Text style={s.label}>Template</Text>
        <View style={s.chips}>
          {templates.map((t) => (
            <Pressable key={t.template_id ?? 'default'} onPress={() => setTemplateId(t.template_id)} style={[s.chip, templateId === t.template_id && s.chipOn]}>
              <Text style={[s.chipText, templateId === t.template_id && s.chipTextOn]}>{t.settings.name}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setEditing(true)} style={s.chip}>
            <Text style={s.chipText}>+ New template</Text>
          </Pressable>
        </View>
        {current ? <Text style={s.mutedSmall}>{LABEL_SIZES[current.size].label}{current.show_card_price ? ' · both prices' : ' · cash price only'}{current.show_barcode ? ' · barcode' : ''}</Text> : null}
        {editing ? (
          <TemplateEditor
            token={token}
            onDone={(id) => {
              setEditing(false);
              if (id) setTemplateId(id);
              setNonce((n) => n + 1);
            }}
          />
        ) : null}

        <Text style={s.label}>Prices changed since their tag was printed</Text>
        {queue?.length === 0 ? <Text style={s.muted}>All tags are up to date.</Text> : null}
        {queue?.slice(0, 15).map((q) => (
          <Text key={q.item_id} style={s.muted}>
            {q.name}: {q.printed_cash_cents !== null ? `${usd(q.printed_cash_cents)} → ` : ''}
            {usd(q.cash_price_cents)} (card {usd(q.card_price_cents)})
          </Text>
        ))}
        {queue && queue.length > 15 ? <Text style={s.muted}>…and {queue.length - 15} more</Text> : null}
        {queue?.length ? (
          <Pressable style={s.button} onPress={() => void print(queue.map((q) => q.item_id))}>
            <Text style={s.buttonText}>Print {queue.length} tags</Text>
          </Pressable>
        ) : null}

        <Text style={s.label}>Or every item in a category</Text>
        <View style={s.chips}>
          {catalog.categories.filter((c) => c.active).map((c) => {
            const ids = catalog.items.filter((i) => i.active && !i.open_price && i.category_id === c.category_id).map((i) => i.item_id);
            return ids.length ? (
              <Pressable key={c.category_id} onPress={() => void print(ids)} style={s.chip}>
                <Text style={s.chipText}>
                  {c.name} ({ids.length})
                </Text>
              </Pressable>
            ) : null;
          })}
        </View>
        {msg ? <Text style={s.muted}>{msg}</Text> : null}
        <Text style={s.mutedSmall}>Items with no barcode get an in-store one on their tag, and it scans at the register.</Text>
      </View>
      <PriceLabels token={token} catalog={catalog} locationId={locationId} />
    </View>
  );
}

function TemplateEditor({ token, onDone }: { token: string; onDone: (templateId: string | null) => void }) {
  const [name, setName] = useState('');
  const [size, setSize] = useState<LabelSize>('avery_5160');
  const [card, setCard] = useState(true);
  const [barcode, setBarcode] = useState(true);
  const [category, setCategory] = useState(false);
  const [note, setNote] = useState('Cash price · Card price');
  const [error, setError] = useState<string | null>(null);
  const parsed = LabelTemplateInput.safeParse({ name: name.trim(), size, show_card_price: card, show_barcode: barcode, show_category: category, note: note.trim() || null });
  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <Pressable onPress={() => set(!on)} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={[s.box, on && s.boxOn]} />
      <Text style={s.body}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={s.inner}>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Template name, e.g. Cooler door" maxLength={40} />
      <View style={s.chips}>
        {(Object.keys(LABEL_SIZES) as LabelSize[]).map((k) => (
          <Pressable key={k} onPress={() => setSize(k)} style={[s.chip, size === k && s.chipOn]}>
            <Text style={[s.chipText, size === k && s.chipTextOn]}>{LABEL_SIZES[k].label}</Text>
          </Pressable>
        ))}
      </View>
      {toggle('Card price (NJ/NY dual pricing: keep it on)', card, setCard)}
      {toggle('Barcode', barcode, setBarcode)}
      {toggle('Category name', category, setCategory)}
      <TextInput style={s.input} value={note} onChangeText={setNote} placeholder="Small print under the prices" maxLength={40} />
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.chips}>
        <Pressable
          style={[s.button, !parsed.success && { opacity: 0.5 }]}
          disabled={!parsed.success}
          onPress={() =>
            void api<{ template_id: string }>('/merchant/labels/templates', token, parsed.data, 'POST').then(
              (r) => onDone(r.template_id),
              (e: Error) => setError(e.message),
            )
          }
        >
          <Text style={s.buttonText}>Save template</Text>
        </Pressable>
        <Pressable style={s.chip} onPress={() => onDone(null)}>
          <Text style={s.chipText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PriceLabels({ token, catalog, locationId }: { token: string; catalog: CatalogSnapshot; locationId: string }) {
  const deli = catalog.items.filter((i) => i.active && i.open_price);
  const [itemId, setItemId] = useState<string | null>(deli[0]?.item_id ?? null);
  const [price, setPrice] = useState('');
  const [copies, setCopies] = useState('1');
  const [msg, setMsg] = useState<string | null>(null);
  if (deli.length === 0) return null;
  const item = deli.find((i) => i.item_id === itemId);
  async function print() {
    setMsg(null);
    try {
      await openPdf('/merchant/labels/price-labels.pdf', token, { item_id: itemId, location_id: locationId, price_cents: parseUsdToCents(price), copies: Math.max(1, Math.min(50, Number(copies) || 1)) });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <View style={s.card}>
      <Text style={s.h2}>Price labels for the deli</Text>
      <Text style={s.muted}>For made-to-order items: the label's barcode carries the price, and the register rings it at that price.</Text>
      <View style={s.chips}>
        {deli.map((i) => (
          <Pressable key={i.item_id} onPress={() => setItemId(i.item_id)} style={[s.chip, itemId === i.item_id && s.chipOn]}>
            <Text style={[s.chipText, itemId === i.item_id && s.chipTextOn]}>{i.name}</Text>
          </Pressable>
        ))}
      </View>
      {item && !item.plu ? <Text style={s.error}>Give {item.name} a PLU (up to 5 digits) in Items first; the label carries it.</Text> : null}
      <View style={s.chips}>
        <Text style={s.body}>$</Text>
        <TextInput style={s.num} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="7.49" accessibilityLabel="Price" />
        <Text style={s.body}>×</Text>
        <TextInput style={s.num} value={copies} onChangeText={(v) => setCopies(v.replace(/\D/g, ''))} keyboardType="number-pad" accessibilityLabel="Copies" />
        <Pressable style={[s.button, (!item?.plu || !price) && { opacity: 0.5 }]} disabled={!item?.plu || !price} onPress={() => void print()}>
          <Text style={s.buttonText}>Print</Text>
        </Pressable>
      </View>
      {msg ? <Text style={s.error}>{msg}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  inner: { gap: 8, padding: 10, borderRadius: 8, backgroundColor: C.ground },
  h2: { fontSize: 17, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginTop: 6 },
  body: { color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  error: { color: '#8a5300' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  check: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: C.muted },
  boxOn: { backgroundColor: C.black, borderColor: C.black },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16 },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 70, fontSize: 16, backgroundColor: '#fff' },
  button: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
});
