/**
 * Inventory at the register (Bible 1.9; P22b, ADR 0034): receive a delivery by scanning it in, and
 * write stock off with a reason. Both become inventory events in the register's log, so they work
 * offline and reach the server with the next sync; stock is folded there.
 */
import { lookupBarcode, searchCatalog, WRITE_OFF_REASONS, type CatalogItem, type CatalogSnapshot, type ScanMatch, type WriteOffReason } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Runtime } from '../runtime';
import { tk, useT } from './i18n';
import { C } from './theme';

interface Line {
  item: CatalogItem;
  qty: number;
  expires_on: string;
}

const REASON_LABEL: Record<WriteOffReason, ReturnType<typeof tk>> = {
  waste: tk('Waste'),
  spoilage: tk('Spoiled'),
  theft: tk('Theft'),
  damaged: tk('Damaged'),
  expired: tk('Expired'),
};

/** Scan each case or item in; a case barcode counts its pack size. Perishables take a date. */
export function ReceivePanel({
  rt,
  catalog,
  index,
  registerScan,
  onDone,
}: {
  rt: Runtime;
  catalog: CatalogSnapshot;
  index: Map<string, ScanMatch>;
  /** The screen's scanner hands codes here while this panel is open. */
  registerScan: (fn: ((code: string) => void) | null) => void;
  onDone: (message: string | null) => void;
}) {
  const t = useT();
  const [lines, setLines] = useState<Line[]>([]);
  const [invoice, setInvoice] = useState('');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = (item: CatalogItem, qty: number) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.item.item_id === item.item_id);
      if (i < 0) return [...ls, { item, qty, expires_on: '' }];
      return ls.map((l, j) => (j === i ? { ...l, qty: l.qty + qty } : l));
    });
  useEffect(() => {
    registerScan((code) => {
      const hit = lookupBarcode(index, code);
      if (hit) {
        add(hit.item, hit.qty);
        setNote(null);
      } else setNote(t('Barcode {code} isn’t in the catalog.', { code }));
    });
    return () => registerScan(null);
  }, [index, registerScan, t]);

  async function finish() {
    setBusy(true);
    try {
      const receiptId = rt.uuid();
      for (const l of lines) {
        await rt.session.recordInventory('inventory.received', {
          receipt_id: receiptId,
          item_id: l.item.item_id,
          qty: l.qty,
          invoice_ref: invoice.trim() || null,
          expires_on: /^\d{4}-\d{2}-\d{2}$/.test(l.expires_on) ? l.expires_on : null,
        });
      }
      rt.log.info('delivery received', { lines: lines.length, units: lines.reduce((n, l) => n + l.qty, 0) });
      rt.sync.kick();
      onDone(t('Received {count} items.', { count: lines.reduce((n, l) => n + l.qty, 0) }));
    } finally {
      setBusy(false);
    }
  }

  const hits = query.trim().length >= 2 ? searchCatalog(catalog, query, 6) : [];
  return (
    <View style={{ gap: 10, maxWidth: 560 }}>
      <Text style={s.title}>{t('Receive a delivery')}</Text>
      <Text style={s.muted}>{t('Scan each case or item. A case barcode counts its pack size.')}</Text>
      <TextInput style={s.input} value={invoice} onChangeText={setInvoice} placeholder={t('Invoice number (optional)')} />
      <TextInput style={s.input} value={query} onChangeText={setQuery} placeholder={t('No barcode? Type the name')} />
      {hits.map((h) => (
        <Pressable key={h.item.item_id} onPress={() => { add(h.item, 1); setQuery(''); }} style={s.hit}>
          <Text>{h.item.name}</Text>
        </Pressable>
      ))}
      {note ? <Text style={s.warn}>{note}</Text> : null}
      <ScrollView style={{ maxHeight: 280 }}>
        {lines.map((l, i) => (
          <View key={l.item.item_id} style={s.line}>
            <Text style={{ flex: 1 }} numberOfLines={1}>
              {l.item.name}
              {l.item.track_stock || l.item.stock_of ? '' : ` · ${t('not tracked')}`}
            </Text>
            {l.item.perishable ? (
              <TextInput
                style={s.date}
                value={l.expires_on}
                onChangeText={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, expires_on: v } : x)))}
                placeholder={t('expires YYYY-MM-DD')}
              />
            ) : null}
            <Pressable onPress={() => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} style={s.step}>
              <Text>−</Text>
            </Pressable>
            <Text style={s.qty}>{l.qty}</Text>
            <Pressable onPress={() => setLines(lines.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))} style={s.step}>
              <Text>+</Text>
            </Pressable>
            <Pressable onPress={() => setLines(lines.filter((_, j) => j !== i))} style={s.step} accessibilityLabel={t('Remove {name}', { name: l.item.name })}>
              <Text>✕</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <View style={s.row}>
        <Pressable onPress={() => onDone(null)} style={s.ghost}>
          <Text>{t('Cancel')}</Text>
        </Pressable>
        <Pressable onPress={() => void finish()} disabled={!lines.length || busy} style={[s.primary, (!lines.length || busy) && { opacity: 0.5 }]}>
          <Text style={s.primaryText}>{t('Add {count} to stock', { count: lines.reduce((n, l) => n + l.qty, 0) })}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Write stock off with a reason. Opened behind the `inventory.write_off` permission (manager PIN). */
export function WriteOffPanel({ rt, catalog, onDone }: { rt: Runtime; catalog: CatalogSnapshot; onDone: (message: string | null) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<WriteOffReason>('damaged');
  const [note, setNote] = useState('');
  const hits = !item && query.trim().length >= 2 ? searchCatalog(catalog, query, 6) : [];
  const n = Math.max(0, Number.parseInt(qty.replace(/\D/g, '') || '0', 10));
  async function save() {
    if (!item || n < 1) return;
    await rt.session.recordInventory('inventory.written_off', { item_id: item.item_id, qty: n, reason, note: note.trim() || null });
    rt.log.info('stock written off', { item: item.name, qty: n, reason });
    rt.sync.kick();
    onDone(t('Wrote off {count} × {name}.', { count: n, name: item.name }));
  }
  return (
    <View style={{ gap: 10, maxWidth: 520 }}>
      <Text style={s.title}>{t('Write off stock')}</Text>
      {item ? (
        <Pressable onPress={() => setItem(null)} style={s.hit}>
          <Text style={{ fontWeight: '700' }}>{item.name} ✕</Text>
        </Pressable>
      ) : (
        <TextInput style={s.input} value={query} onChangeText={setQuery} placeholder={t('Which item?')} autoFocus />
      )}
      {hits.map((h) => (
        <Pressable key={h.item.item_id} onPress={() => setItem(h.item)} style={s.hit}>
          <Text>{h.item.name}</Text>
        </Pressable>
      ))}
      <View style={s.row}>
        <Text>{t('How many')}</Text>
        <TextInput style={s.num} value={qty} onChangeText={setQty} keyboardType="number-pad" />
      </View>
      <View style={s.chips}>
        {WRITE_OFF_REASONS.map((r) => (
          <Pressable key={r} onPress={() => setReason(r)} style={[s.chip, reason === r && s.chipOn]}>
            <Text style={reason === r ? { color: '#fff', fontWeight: '700' } : undefined}>{t(REASON_LABEL[r])}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput style={s.input} value={note} onChangeText={setNote} placeholder={t('Note (optional)')} maxLength={200} />
      <View style={s.row}>
        <Pressable onPress={() => onDone(null)} style={s.ghost}>
          <Text>{t('Cancel')}</Text>
        </Pressable>
        <Pressable onPress={() => void save()} disabled={!item || n < 1} style={[s.primary, (!item || n < 1) && { opacity: 0.5 }]}>
          <Text style={s.primaryText}>{t('Write off')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 20, fontWeight: '800', color: C.ink },
  muted: { color: C.muted },
  warn: { color: C.amber, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 10, fontSize: 16, backgroundColor: '#fff' },
  hit: { padding: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: '#fff' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line },
  date: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4, width: 120, fontSize: 13 },
  step: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  qty: { minWidth: 28, textAlign: 'center', fontWeight: '800', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'flex-end' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  num: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 8, width: 80, fontSize: 16, backgroundColor: '#fff' },
  ghost: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#fff' },
  primary: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  primaryText: { color: '#fff', fontWeight: '700' },
});
