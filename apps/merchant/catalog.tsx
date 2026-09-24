/**
 * Catalog from the phone (build plan P2, Bible 2.3 / L34, L35, L2): add or edit an item with a
 * photo, set favorites and tile colors for the register, manage categories, and change the
 * dual-price % with a preview of the card prices before saving. Every save bumps the catalog
 * version; registers pick it up on their next sync tick (≤ 15 s).
 *
 * Money is typed as dollars and parsed to integer cents with parseUsdToCents; nothing here does
 * float arithmetic on an amount. Tile colors come from the fixed palette (no red, no green).
 */
import {
  MAX_QUICK_KEYS,
  TILE_COLORS,
  parseUsdToCents,
  percentToPpm,
  ppmToPercent,
  resolveDualPrice,
  type CatalogCategory,
  type CatalogItem,
  type CatalogSnapshot,
  type TileColor,
} from '@adpay/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, apiUrl } from './api';
import { captureAndUpload, type PhotoSource } from './photo';
import { C, dollars, usd } from './theme';

interface LocationSummary {
  location_id: string;
  name: string;
  state: string | null;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

type Screen = { kind: 'list' } | { kind: 'edit'; item: CatalogItem | null };
type Section = 'items' | 'favorites' | 'categories' | 'pricing';

const PUSHED = 'Registers update within 15 seconds.';

export function CatalogTab({ token }: { token: string }) {
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('items');
  const [view, setView] = useState<Screen>({ kind: 'list' });

  const load = useCallback(async () => {
    try {
      const { locations: locs } = await api<{ locations: LocationSummary[] }>('/merchant/locations', token);
      setLocations(locs);
      const loc = locationId ?? locs[0]?.location_id ?? null;
      if (!locationId && loc) setLocationId(loc);
      if (loc) setCatalog(await api<CatalogSnapshot>(`/merchant/catalog/editor?location_id=${loc}`, token));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = (msg: string) => {
    setNotice(`${msg} ${PUSHED}`);
    setTimeout(() => setNotice(null), 5000);
    void load();
  };

  if (error && !catalog) return <Text style={[s.error, { padding: 16 }]}>{error}</Text>;
  if (!catalog || !locations || !locationId) return <ActivityIndicator style={{ marginTop: 24 }} />;
  const loc = locations.find((l) => l.location_id === locationId)!;

  if (view.kind === 'edit') {
    return (
      <ItemEditor
        token={token}
        item={view.item}
        catalog={catalog}
        location={loc}
        onClose={() => setView({ kind: 'list' })}
        onSaved={(msg) => {
          setView({ kind: 'list' });
          saved(msg);
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      {locations.length > 1 ? (
        <Chips
          options={locations.map((l) => ({ key: l.location_id, label: l.name }))}
          value={locationId}
          onChange={(id) => setLocationId(id)}
        />
      ) : null}
      <View style={s.segment}>
        {(['items', 'favorites', 'categories', 'pricing'] as const).map((k) => (
          <Pressable key={k} onPress={() => setSection(k)} style={[s.segmentItem, section === k && s.segmentActive]}>
            <Text style={[s.segmentText, section === k && { color: '#fff' }]}>{k[0]!.toUpperCase() + k.slice(1)}</Text>
          </Pressable>
        ))}
      </View>
      {notice ? <Text style={s.notice}>{notice}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {section === 'items' && <ItemList catalog={catalog} onEdit={(item) => setView({ kind: 'edit', item })} />}
      {section === 'favorites' && <Favorites token={token} catalog={catalog} location={loc} onSaved={saved} />}
      {section === 'categories' && <Categories token={token} catalog={catalog} onSaved={saved} />}
      {section === 'pricing' && <Pricing token={token} catalog={catalog} location={loc} onSaved={saved} />}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────── items ──

function Thumb({ item, size = 44 }: { item: CatalogItem; size?: number }) {
  const palette = item.color ? TILE_COLORS[item.color] : null;
  if (item.image_url) return <Image source={{ uri: apiUrl(item.image_url) }} style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.ground }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: palette?.fill ?? C.ground, borderTopWidth: 4, borderTopColor: palette?.stripe ?? C.line }} />
  );
}

function ItemList({ catalog, onEdit }: { catalog: CatalogSnapshot; onEdit: (i: CatalogItem | null) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.items.filter(
      (i) =>
        (!cat || i.category_id === cat) &&
        (!needle || i.name.toLowerCase().includes(needle) || i.upc?.includes(needle) || i.plu?.includes(needle)),
    );
  }, [catalog.items, q, cat]);
  return (
    <>
      <Pressable style={s.button} onPress={() => onEdit(null)}>
        <Text style={s.buttonText}>+ Add item</Text>
      </Pressable>
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Search name, UPC or PLU" autoCorrect={false} />
      <Chips
        options={[{ key: '', label: 'All' }, ...catalog.categories.map((c) => ({ key: c.category_id, label: c.name }))]}
        value={cat ?? ''}
        onChange={(k) => setCat(k || null)}
      />
      <View style={s.card}>
        {rows.length === 0 ? <Text style={s.muted}>No items match.</Text> : null}
        {rows.map((i) => (
          <Pressable key={i.item_id} style={[s.line, !i.active && { opacity: 0.5 }]} onPress={() => onEdit(i)}>
            <Thumb item={i} />
            <View style={{ flex: 1 }}>
              <Text style={s.lineName}>{i.name}</Text>
              <Text style={s.mutedSmall}>
                {catalog.categories.find((c) => c.category_id === i.category_id)?.name ?? 'Uncategorized'}
                {i.active ? '' : ' · hidden'}
                {i.open_price ? ' · open price' : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.money}>{usd(i.cash_price_cents)}</Text>
              <Text style={s.mutedSmall}>{usd(i.card_price_cents)} card</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </>
  );
}

function ItemEditor({
  token,
  item,
  catalog,
  location,
  onClose,
  onSaved,
}: {
  token: string;
  item: CatalogItem | null;
  catalog: CatalogSnapshot;
  location: LocationSummary;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const wasFavorite = !!item && catalog.quick_keys.includes(item.item_id);
  const [f, setF] = useState({
    name: item?.name ?? '',
    category_id: item?.category_id ?? catalog.categories.find((c) => c.active)?.category_id ?? null,
    cash: dollars(item?.cash_price_cents ?? null),
    customCard: item?.card_price_override ?? false,
    card: item?.card_price_override ? dollars(item.card_price_cents) : '',
    cost: dollars(item?.cost_cents ?? null),
    upc: item?.upc ?? '',
    open_price: item?.open_price ?? false,
    color: (item?.color ?? null) as TileColor | null,
    image: item?.image_url ? { media_id: null as string | null, url: item.image_url } : null,
    active: item?.active ?? true,
    favorite: wasFavorite,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const cashCents = f.cash.trim() ? attempt(() => parseUsdToCents(f.cash)) : null;
  const autoCard = cashCents !== null ? resolveDualPrice({ cash_price_cents: cashCents, card_price_cents: null }, location.dual_price_rate_ppm).card : null;

  async function photo(source: PhotoSource) {
    setError(null);
    setBusy('Uploading photo…');
    try {
      const up = await captureAndUpload(token, source);
      if (up) set('image', { media_id: up.media_id, url: up.url });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function money(label: string, text: string, required: boolean): number | null {
    if (!text.trim()) {
      if (required) throw new Error(`${label} is required`);
      return null;
    }
    try {
      return parseUsdToCents(text);
    } catch {
      throw new Error(`${label}: enter an amount like 2.49`);
    }
  }

  async function save() {
    setError(null);
    let body: Record<string, unknown>;
    try {
      if (!f.name.trim()) throw new Error('Name is required');
      body = {
        name: f.name.trim(),
        category_id: f.category_id,
        cash_price_cents: f.open_price ? (money('Price', f.cash, false) ?? 0) : money('Price', f.cash, true),
        card_price_cents: f.customCard ? money('Card price', f.card, true) : null,
        cost_cents: money('Cost', f.cost, false),
        upc: f.upc.trim() || null,
        open_price: f.open_price,
        color: f.color,
        active: f.active,
      };
      // Only send the photo when it changed: a new upload, or removed.
      if (f.image?.media_id) body.image_id = f.image.media_id;
      else if (!f.image && item?.image_url) body.image_id = null;
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy('Saving…');
    try {
      const r = await api<{ item_id: string; catalog_version: number }>(
        item ? `/merchant/items/${item.item_id}` : '/merchant/items',
        token,
        body,
        item ? 'PATCH' : 'POST',
      );
      if (f.favorite !== wasFavorite) {
        const ids = f.favorite ? [...catalog.quick_keys, r.item_id] : catalog.quick_keys.filter((id) => id !== r.item_id);
        if (ids.length > MAX_QUICK_KEYS) throw new Error(`Saved, but favorites are full (${MAX_QUICK_KEYS}). Remove one first.`);
        await api(`/merchant/locations/${location.location_id}/quick-keys`, token, { item_ids: ids }, 'PUT');
      }
      onSaved(`${item ? 'Saved' : 'Added'} “${f.name.trim()}”.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <View style={s.rowBetween}>
        <Pressable onPress={onClose}>
          <Text style={s.link}>‹ Items</Text>
        </Pressable>
        <Text style={s.h2}>{item ? 'Edit item' : 'New item'}</Text>
        <View style={{ width: 50 }} />
      </View>

      <View style={[s.card, { alignItems: 'center', gap: 10 }]}>
        {f.image ? (
          <Image source={{ uri: apiUrl(f.image.url) }} style={s.photo} accessibilityLabel="Item photo" />
        ) : (
          <View style={[s.photo, { alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={s.muted}>No photo</Text>
          </View>
        )}
        <View style={s.row}>
          {Platform.OS !== 'web' ? <SmallButton label="Take photo" onPress={() => void photo('camera')} /> : null}
          <SmallButton label={Platform.OS === 'web' ? 'Choose photo' : 'From library'} onPress={() => void photo('library')} />
          {f.image ? <SmallButton label="Remove" onPress={() => set('image', null)} /> : null}
        </View>
      </View>

      <Field label="Name">
        <TextInput style={s.input} value={f.name} onChangeText={(t) => set('name', t)} maxLength={120} placeholder="Turkey club" />
      </Field>

      <Field label="Category">
        <Chips
          options={[...catalog.categories.map((c) => ({ key: c.category_id, label: c.name + (c.active ? '' : ' (hidden)') })), { key: '', label: 'None' }]}
          value={f.category_id ?? ''}
          onChange={(k) => set('category_id', k || null)}
        />
      </Field>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.lineName}>Open price (type it at the register)</Text>
          <Switch value={f.open_price} onValueChange={(v) => set('open_price', v)} />
        </View>
      </View>

      <View style={s.row}>
        <Field label={f.open_price ? 'Default price' : 'Cash price'} flex>
          <TextInput style={s.input} value={f.cash} onChangeText={(t) => set('cash', t)} keyboardType="decimal-pad" placeholder="2.49" />
        </Field>
        <Field label="Your cost" flex>
          <TextInput style={s.input} value={f.cost} onChangeText={(t) => set('cost', t)} keyboardType="decimal-pad" placeholder="1.20" />
        </Field>
      </View>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={s.lineName}>Card price</Text>
            <Text style={s.mutedSmall}>
              {f.customCard
                ? 'Fixed at every location (e.g. lottery at face value)'
                : `Automatic: cash + ${ppmToPercent(location.dual_price_rate_ppm)}%${autoCard !== null ? ` = ${usd(autoCard)}` : ''} at ${location.name}`}
            </Text>
          </View>
          <Switch value={f.customCard} onValueChange={(v) => set('customCard', v)} />
        </View>
        {f.customCard ? (
          <TextInput style={[s.input, { marginTop: 8 }]} value={f.card} onChangeText={(t) => set('card', t)} keyboardType="decimal-pad" placeholder="2.59" />
        ) : null}
      </View>

      <Field label="Barcode (UPC)">
        <TextInput style={s.input} value={f.upc} onChangeText={(t) => set('upc', t)} keyboardType="number-pad" placeholder="Scan or type" />
      </Field>

      <Field label="Tile color on the register">
        <View style={s.row}>
          <Pressable onPress={() => set('color', null)} style={[s.swatch, { backgroundColor: '#fff' }, f.color === null && s.swatchOn]} accessibilityLabel="No color">
            <Text style={s.mutedSmall}>none</Text>
          </Pressable>
          {(Object.keys(TILE_COLORS) as TileColor[]).map((k) => (
            <Pressable
              key={k}
              onPress={() => set('color', k)}
              accessibilityLabel={TILE_COLORS[k].label}
              style={[s.swatch, { backgroundColor: TILE_COLORS[k].fill, borderTopColor: TILE_COLORS[k].stripe, borderTopWidth: 6 }, f.color === k && s.swatchOn]}
            />
          ))}
        </View>
      </Field>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.lineName}>★ Favorite at {location.name}</Text>
          <Switch value={f.favorite} onValueChange={(v) => set('favorite', v)} />
        </View>
        <View style={[s.rowBetween, { marginTop: 8 }]}>
          <Text style={s.lineName}>For sale on registers</Text>
          <Switch value={f.active} onValueChange={(v) => set('active', v)} />
        </View>
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}
      <Pressable style={[s.button, !!busy && { opacity: 0.5 }]} disabled={!!busy} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ?? (item ? 'Save' : 'Add item')}</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────── favorites ──

function Favorites({ token, catalog, location, onSaved }: { token: string; catalog: CatalogSnapshot; location: LocationSummary; onSaved: (m: string) => void }) {
  const byId = useMemo(() => new Map(catalog.items.map((i) => [i.item_id, i])), [catalog.items]);
  const [ids, setIds] = useState<string[]>(catalog.quick_keys.filter((id) => byId.has(id)));
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = ids.join() !== catalog.quick_keys.join();

  const move = (i: number, d: -1 | 1) =>
    setIds((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const needle = q.trim().toLowerCase();
  const candidates = needle ? catalog.items.filter((i) => i.active && !ids.includes(i.item_id) && i.name.toLowerCase().includes(needle)).slice(0, 8) : [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/merchant/locations/${location.location_id}/quick-keys`, token, { item_ids: ids }, 'PUT');
      onSaved(`Favorites saved for ${location.name}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={s.muted}>
        The first page of keys on {location.name}'s register, in this order. Up to {MAX_QUICK_KEYS}.
      </Text>
      <View style={s.card}>
        {ids.length === 0 ? <Text style={s.muted}>No favorites yet. Search below to add some.</Text> : null}
        {ids.map((id, n) => {
          const i = byId.get(id)!;
          return (
            <View key={id} style={s.line}>
              <Thumb item={i} size={36} />
              <Text style={[s.lineName, { flex: 1 }]}>
                {n + 1}. {i.name}
              </Text>
              <SmallButton label="↑" onPress={() => move(n, -1)} />
              <SmallButton label="↓" onPress={() => move(n, 1)} />
              <SmallButton label="✕" onPress={() => setIds((p) => p.filter((x) => x !== id))} />
            </View>
          );
        })}
      </View>
      <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Add a favorite: search items" autoCorrect={false} />
      {candidates.map((i) => (
        <Pressable
          key={i.item_id}
          style={s.ticket}
          onPress={() => {
            if (ids.length >= MAX_QUICK_KEYS) return setError(`Favorites are full (${MAX_QUICK_KEYS}).`);
            setIds((p) => [...p, i.item_id]);
            setQ('');
          }}
        >
          <Thumb item={i} size={32} />
          <Text style={[s.lineName, { flex: 1 }]}>{i.name}</Text>
          <Text style={s.link}>+ Add</Text>
        </Pressable>
      ))}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Pressable style={[s.button, (!dirty || busy) && { opacity: 0.5 }]} disabled={!dirty || busy} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save favorites'}</Text>
      </Pressable>
    </>
  );
}

// ─────────────────────────────────────────────────────────── categories ──

function Categories({ token, catalog, onSaved }: { token: string; catalog: CatalogSnapshot; onSaved: (m: string) => void }) {
  const [order, setOrder] = useState(catalog.categories.map((c) => c.category_id));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(catalog.categories.map((c) => [c.category_id, c]));
  const reordered = order.join() !== catalog.categories.map((c) => c.category_id).join();

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      onSaved(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const patch = (c: CatalogCategory, body: Record<string, unknown>, msg: string) =>
    run(() => api(`/merchant/categories/${c.category_id}`, token, body, 'PATCH'), msg);
  const move = (i: number, d: -1 | 1) =>
    setOrder((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <>
      <View style={s.card}>
        {order.map((id, n) => {
          const c = byId.get(id)!;
          const count = catalog.items.filter((i) => i.category_id === id).length;
          return (
            <View key={id} style={[s.line, !c.active && { opacity: 0.55 }]}>
              <View style={{ flex: 1 }}>
                <Text style={s.lineName}>{c.name}</Text>
                <Text style={s.mutedSmall}>
                  {count} items{c.min_age ? ` · ${c.min_age}+` : ''}
                  {c.taxable ? '' : ' · no tax'}
                  {c.active ? '' : ' · hidden'}
                </Text>
              </View>
              <SmallButton label="↑" onPress={() => move(n, -1)} />
              <SmallButton label="↓" onPress={() => move(n, 1)} />
              <SmallButton label={c.active ? 'Hide' : 'Show'} onPress={() => void patch(c, { active: !c.active }, `“${c.name}” ${c.active ? 'hidden' : 'shown'}.`)} />
            </View>
          );
        })}
      </View>
      {reordered ? (
        <Pressable style={s.button} onPress={() => void run(() => api('/merchant/catalog/order', token, { categories: order }, 'PUT'), 'Category order saved.')}>
          <Text style={s.buttonText}>Save order</Text>
        </Pressable>
      ) : null}
      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1 }]} value={name} onChangeText={setName} placeholder="New category" maxLength={60} />
        <SmallButton
          label="Add"
          onPress={() =>
            name.trim() &&
            void run(async () => {
              await api('/merchant/categories', token, { name: name.trim() });
              setName('');
            }, `Category “${name.trim()}” added.`)
          }
        />
      </View>
      <Text style={s.mutedSmall}>Age checks and tax settings per category are managed by AD Pay support for now.</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────── pricing ──

function Pricing({ token, catalog, location, onSaved }: { token: string; catalog: CatalogSnapshot; location: LocationSummary; onSaved: (m: string) => void }) {
  const [text, setText] = useState(ppmToPercent(location.dual_price_rate_ppm));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ppm = attempt(() => percentToPpm(text));
  const changes = useMemo(() => {
    if (ppm === null || ppm === location.dual_price_rate_ppm) return [];
    return catalog.items
      .filter((i) => i.active && !i.card_price_override)
      .map((i) => ({ item: i, next: resolveDualPrice({ cash_price_cents: i.cash_price_cents, card_price_cents: null }, ppm!).card }))
      .filter((c) => c.next !== c.item.card_price_cents);
  }, [ppm, catalog.items, location.dual_price_rate_ppm]);

  async function save() {
    if (ppm === null) return setError('Enter a percentage like 4 or 3.5');
    setBusy(true);
    setError(null);
    try {
      await api(`/merchant/locations/${location.location_id}/rates`, token, { dual_price_rate_ppm: ppm }, 'PATCH');
      onSaved(`Card prices at ${location.name} now cash + ${ppmToPercent(ppm)}%.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <View style={s.card}>
        <Text style={s.label}>Card price at {location.name}</Text>
        <View style={[s.row, { alignItems: 'center' }]}>
          <Text style={s.lineName}>cash +</Text>
          <TextInput style={[s.input, { width: 90 }]} value={text} onChangeText={setText} keyboardType="decimal-pad" />
          <Text style={s.lineName}>%</Text>
        </View>
        <Text style={[s.mutedSmall, { marginTop: 6 }]}>Sales tax here: {ppmToPercent(location.tax_rate_ppm)}%. Items with their own fixed card price don't change.</Text>
      </View>
      {changes.length > 0 ? (
        <View style={s.card}>
          <Text style={s.label}>Preview — {changes.length} card prices change</Text>
          {changes.slice(0, 10).map((c) => (
            <View key={c.item.item_id} style={s.line}>
              <Text style={[s.lineName, { flex: 1 }]}>{c.item.name}</Text>
              <Text style={s.mutedSmall}>{usd(c.item.card_price_cents)} →</Text>
              <Text style={s.money}>{usd(c.next)}</Text>
            </View>
          ))}
          {changes.length > 10 ? <Text style={s.mutedSmall}>…and {changes.length - 10} more</Text> : null}
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Pressable style={[s.button, (busy || changes.length === 0) && { opacity: 0.5 }]} disabled={busy || changes.length === 0} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Push new card prices'}</Text>
      </Pressable>
    </>
  );
}

// ─────────────────────────────────────────────────────────── bits ──

/** Parse-as-you-type: the value, or null while the text isn't valid yet. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function Field({ label, children, flex }: { label: string; children: ReactNode; flex?: boolean }) {
  return (
    <View style={flex ? { flex: 1 } : undefined}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

function Chips({ options, value, onChange }: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o.key} onPress={() => onChange(o.key)} style={[s.chip, value === o.key && s.chipOn]}>
          <Text style={[s.chipText, value === o.key && { color: '#fff' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={s.small} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={s.smallText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' },
  h2: { fontSize: 18, fontWeight: '700', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  button: { backgroundColor: C.red, borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  small: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, minWidth: 40, alignItems: 'center' },
  smallText: { fontWeight: '600', color: C.ink },
  error: { color: C.red },
  notice: { backgroundColor: '#fff', borderLeftWidth: 4, borderLeftColor: C.black, padding: 10, borderRadius: 6, color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  link: { color: C.ink, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 10 },
  lineName: { color: C.ink, fontWeight: '600', flexShrink: 1 },
  money: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  segment: { flexDirection: 'row', backgroundColor: '#e9e9e9', borderRadius: 8, padding: 3 },
  segmentItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segmentActive: { backgroundColor: C.black },
  segmentText: { fontWeight: '600', color: C.ink, fontSize: 13 },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '600' },
  swatch: { width: 44, height: 44, borderRadius: 8, borderWidth: 2, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { borderColor: C.black, borderWidth: 3 },
  photo: { width: 160, height: 160, borderRadius: 12, backgroundColor: C.ground },
  ticket: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
});
