'use client';
/**
 * Catalog editor (build plan P1): location pricing with a card-price preview, item list with search
 * and filters, item create/edit with price history, and category management. Every save bumps the
 * catalog version; registers pick it up on their next sync (≤ 15s).
 *
 * Money is typed as dollars and parsed to integer cents with parseUsdToCents before it leaves the
 * form; nothing here does float arithmetic on an amount.
 */
import {
  cents,
  formatUsd,
  parseUsdToCents,
  percentToPpm,
  ppmToPercent,
  resolveDualPrice,
  sub,
  type CatalogCategory,
  type CatalogItem,
  type CatalogSnapshot,
  type PriceHistoryEntry,
} from '@adpay/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ErrorBox, Money, When, useLoad } from './ui';

interface LocationSummary {
  location_id: string;
  name: string;
  city: string | null;
  state: string | null;
  tax_rate_ppm: number;
  dual_price_rate_ppm: number;
}

const dollars = (c: number | null) => (c === null ? '' : formatUsd(cents(c)).replace('$', '').replace(/,/g, ''));

/** Gross margin for display only: tenths of a percent, integer arithmetic. */
function marginText(cash: number, cost: number | null): string {
  if (cost === null || cash === 0) return '—';
  const tenths = Math.trunc((sub(cents(cash), cents(cost)) * 1000) / cash);
  return `${tenths / 10}%`;
}

export function CatalogEditor({ merchantId }: { merchantId: string }) {
  const base = `/admin/merchants/${merchantId}`;
  const locations = useLoad(() => api<{ locations: LocationSummary[] }>(`${base}/locations`), [merchantId]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const activeLocation = locationId ?? locations.data?.locations[0]?.location_id ?? null;
  const catalog = useLoad(
    () => (activeLocation ? api<CatalogSnapshot>(`${base}/catalog/editor?location_id=${activeLocation}`) : Promise.resolve(null)),
    [merchantId, activeLocation],
  );
  const [editing, setEditing] = useState<CatalogItem | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saved = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
    catalog.reload();
    locations.reload();
  };

  const loc = locations.data?.locations.find((l) => l.location_id === activeLocation) ?? null;

  return (
    <>
      <ErrorBox error={locations.error ?? catalog.error} />
      {notice && <div className="notice">{notice}</div>}
      {loc && catalog.data && (
        <>
          <div className="toolbar">
            <label className="field">
              Priced at location
              <select value={activeLocation ?? ''} onChange={(e) => setLocationId(e.target.value)}>
                {locations.data!.locations.map((l) => (
                  <option key={l.location_id} value={l.location_id}>
                    {l.name}
                    {l.state ? `, ${l.state}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">
              Catalog version <strong>v{catalog.data.catalog_version}</strong> · registers pick up changes within ~15 seconds
            </span>
          </div>
          <LocationPricing base={base} loc={loc} items={catalog.data.items} onSaved={saved} />
          <Categories base={base} categories={catalog.data.categories} items={catalog.data.items} onSaved={saved} />
          <Items
            catalog={catalog.data}
            onNew={() => setEditing('new')}
            onEdit={(i) => setEditing(i)}
          />
        </>
      )}
      {editing && catalog.data && (
        <ItemDrawer
          base={base}
          item={editing === 'new' ? null : editing}
          categories={catalog.data.categories}
          dualRate={catalog.data.dual_price_rate_ppm}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            saved(msg);
          }}
        />
      )}
    </>
  );
}

function LocationPricing({
  base,
  loc,
  items,
  onSaved,
}: {
  base: string;
  loc: LocationSummary;
  items: CatalogItem[];
  onSaved: (msg: string) => void;
}) {
  const [dual, setDual] = useState(ppmToPercent(loc.dual_price_rate_ppm));
  const [tax, setTax] = useState(ppmToPercent(loc.tax_rate_ppm));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(loc.location_id);
  if (key !== loc.location_id) {
    setKey(loc.location_id);
    setDual(ppmToPercent(loc.dual_price_rate_ppm));
    setTax(ppmToPercent(loc.tax_rate_ppm));
  }

  let dualPpm: number | null = null;
  let taxPpm: number | null = null;
  try {
    dualPpm = percentToPpm(dual);
  } catch {
    dualPpm = null;
  }
  try {
    taxPpm = percentToPpm(tax);
  } catch {
    taxPpm = null;
  }

  // Preview: which card prices change if the % changes (explicit card prices never change).
  const changes = useMemo(() => {
    if (dualPpm === null || dualPpm === loc.dual_price_rate_ppm) return [];
    return items
      .filter((i) => !i.card_price_override && i.active)
      .map((i) => ({ item: i, next: resolveDualPrice({ cash_price_cents: i.cash_price_cents, card_price_cents: null }, dualPpm!).card }))
      .filter((c) => c.next !== c.item.card_price_cents);
  }, [dualPpm, items, loc.dual_price_rate_ppm]);

  const dirty = (dualPpm !== null && dualPpm !== loc.dual_price_rate_ppm) || (taxPpm !== null && taxPpm !== loc.tax_rate_ppm);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (dualPpm === null || taxPpm === null) return setError(new Error('Enter percentages like 4 or 6.625'));
    setBusy(true);
    try {
      const r = await api<{ catalog_version: number }>(`${base}/locations/${loc.location_id}/rates`, {
        method: 'PATCH',
        body: { dual_price_rate_ppm: dualPpm, tax_rate_ppm: taxPpm },
      });
      onSaved(`${loc.name}: rates saved — catalog v${r.catalog_version}, ${changes.length} card prices changed`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Pricing at {loc.name}</h2>
      <form className="inline" onSubmit={save}>
        <label className="field">
          Card price = cash +
          <span className="suffix-input">
            <input value={dual} onChange={(e) => setDual(e.target.value)} style={{ width: 70 }} inputMode="decimal" />%
          </span>
        </label>
        <label className="field">
          Sales tax
          <span className="suffix-input">
            <input value={tax} onChange={(e) => setTax(e.target.value)} style={{ width: 80 }} inputMode="decimal" />%
          </span>
        </label>
        <button className="primary" disabled={!dirty || busy || dualPpm === null || taxPpm === null}>
          {busy ? 'Saving…' : 'Save rates'}
        </button>
        {dualPpm === null && <span className="error-inline">Card % must be a number like 4 or 3.5</span>}
      </form>
      {changes.length > 0 && (
        <div className="preview">
          <strong>Preview:</strong> {changes.length} card price{changes.length === 1 ? '' : 's'} will change at {loc.name}. Items with their own
          card price (e.g. lottery at face value) stay as they are.
          <div className="table-wrap">
            <table>
              <tbody>
                {changes.slice(0, 8).map((c) => (
                  <tr key={c.item.item_id}>
                    <td>{c.item.name}</td>
                    <td className="num">
                      <Money cents={c.item.cash_price_cents} /> cash
                    </td>
                    <td className="num muted">
                      <Money cents={c.item.card_price_cents} />
                    </td>
                    <td className="num">
                      → <Money cents={c.next} /> card
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {changes.length > 8 && <div className="muted">…and {changes.length - 8} more</div>}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function Categories({
  base,
  categories,
  items,
  onSaved,
}: {
  base: string;
  categories: CatalogCategory[];
  items: CatalogItem[];
  onSaved: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [minAge, setMinAge] = useState('');
  const [taxable, setTaxable] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function patch(c: CatalogCategory, body: Record<string, unknown>) {
    setError(null);
    try {
      await api(`${base}/categories/${c.category_id}`, { method: 'PATCH', body });
      onSaved(`Category “${c.name}” updated`);
    } catch (e) {
      setError(e);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`${base}/categories`, {
        method: 'POST',
        body: { name: name.trim(), taxable, min_age: minAge ? Number(minAge) : null },
      });
      setName('');
      setMinAge('');
      onSaved(`Category “${name.trim()}” added`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Categories ({categories.filter((c) => c.active).length} active)</h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Manage categories'}</button>
      </div>
      {open && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Items</th>
                  <th>Taxable</th>
                  <th>Age check</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.category_id} className={c.active ? '' : 'inactive'}>
                    <td>
                      <input
                        defaultValue={c.name}
                        onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && patch(c, { name: e.target.value.trim() })}
                      />
                    </td>
                    <td className="num">{items.filter((i) => i.category_id === c.category_id).length}</td>
                    <td>
                      <input type="checkbox" checked={c.taxable} onChange={(e) => patch(c, { taxable: e.target.checked })} />
                    </td>
                    <td>
                      <select value={c.min_age ?? ''} onChange={(e) => patch(c, { min_age: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">none</option>
                        <option value="18">18+</option>
                        <option value="21">21+</option>
                      </select>
                    </td>
                    <td>{c.active ? <span className="pill ok">active</span> : <span className="pill">hidden</span>}</td>
                    <td>
                      <button onClick={() => patch(c, { active: !c.active })}>{c.active ? 'Hide' : 'Show'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="inline" onSubmit={add} style={{ marginTop: 12 }}>
            <input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> taxable
            </label>
            <select value={minAge} onChange={(e) => setMinAge(e.target.value)}>
              <option value="">no age check</option>
              <option value="18">18+</option>
              <option value="21">21+</option>
            </select>
            <button disabled={!name.trim()}>Add category</button>
          </form>
          <p className="muted" style={{ marginBottom: 0 }}>
            Hidden categories disappear from the register's quick keys; their items stay in the catalog.
          </p>
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function Items({ catalog, onNew, onEdit }: { catalog: CatalogSnapshot; onNew: () => void; onEdit: (i: CatalogItem) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const catName = (id: string | null) => catalog.categories.find((c) => c.category_id === id)?.name ?? 'Uncategorized';

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.items.filter(
      (i) =>
        (showInactive || i.active) &&
        (!cat || i.category_id === cat) &&
        (!needle ||
          i.name.toLowerCase().includes(needle) ||
          i.upc?.includes(needle) ||
          i.plu?.includes(needle) ||
          i.barcodes.some((b) => b.barcode.includes(needle))),
    );
  }, [catalog.items, q, cat, showInactive]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Items <span className="muted">({rows.length} of {catalog.items.length})</span>
        </h2>
        <button className="primary" onClick={onNew}>
          + New item
        </button>
      </div>
      <div className="toolbar">
        <input placeholder="Search name, UPC or PLU" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {catalog.categories.map((c) => (
            <option key={c.category_id} value={c.category_id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show inactive
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>UPC / PLU</th>
              <th className="num">Cash</th>
              <th className="num">Card</th>
              <th className="num">Cost</th>
              <th className="num">Margin</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.item_id} className={`link${i.active ? '' : ' inactive'}`} onClick={() => onEdit(i)}>
                <td>
                  <strong>{i.name}</strong>
                </td>
                <td className="muted">{catName(i.category_id)}</td>
                <td className="mono">
                  {i.upc ?? '—'}
                  {i.plu ? ` · PLU ${i.plu}` : ''}
                  {i.barcodes.length > 0 && <span className="muted"> +{i.barcodes.length}</span>}
                </td>
                <td className="num">{i.open_price ? <span className="muted">open</span> : <Money cents={i.cash_price_cents} />}</td>
                <td className="num">
                  {i.open_price ? (
                    <span className="muted">open</span>
                  ) : (
                    <>
                      <Money cents={i.card_price_cents} />
                      <div className="tiny muted">{i.card_price_override ? 'custom' : 'auto'}</div>
                    </>
                  )}
                </td>
                <td className="num">{i.cost_cents === null ? <span className="muted">—</span> : <Money cents={i.cost_cents} />}</td>
                <td className="num">{marginText(i.cash_price_cents, i.cost_cents)}</td>
                <td>
                  {!i.active && <span className="pill">inactive</span>} {!i.taxable && <span className="pill">no tax</span>}{' '}
                  {i.min_age && <span className="pill warn">{i.min_age}+</span>} {i.sell_unit === 'pack' && <span className="pill">pack of {i.pack_qty}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No items match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemDrawer({
  base,
  item,
  categories,
  dualRate,
  onClose,
  onSaved,
}: {
  base: string;
  item: CatalogItem | null;
  categories: CatalogCategory[];
  dualRate: number;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [f, setF] = useState({
    name: item?.name ?? '',
    category_id: item?.category_id ?? categories.find((c) => c.active)?.category_id ?? '',
    cash: dollars(item?.cash_price_cents ?? null),
    cardMode: item?.card_price_override ? 'custom' : 'auto',
    card: item?.card_price_override ? dollars(item.card_price_cents) : '',
    cost: dollars(item?.cost_cents ?? null),
    upc: item?.upc ?? '',
    plu: item?.plu ?? '',
    open_price: item?.open_price ?? false,
    sell_unit: item?.sell_unit ?? 'each',
    pack_qty: String(item?.pack_qty ?? 1),
    barcodes: (item?.barcodes ?? []).map((b) => (b.pack_qty > 1 ? `${b.barcode} x${b.pack_qty}` : b.barcode)).join('\n'),
    active: item?.active ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const history = useLoad(
    () => (item ? api<{ history: PriceHistoryEntry[] }>(`${base}/items/${item.item_id}/history`) : Promise.resolve({ history: [] })),
    [item?.item_id],
  );
  const set = (k: keyof typeof f, v: string | boolean) => setF((prev) => ({ ...prev, [k]: v }));

  // Live card-price preview from what's typed.
  let cashCents: number | null;
  try {
    cashCents = f.cash.trim() ? parseUsdToCents(f.cash) : null;
  } catch {
    cashCents = null;
  }
  const autoCard = cashCents !== null ? resolveDualPrice({ cash_price_cents: cashCents, card_price_cents: null }, dualRate).card : null;

  function build(): Record<string, unknown> {
    const money = (label: string, s: string, required: boolean) => {
      if (!s.trim()) {
        if (required) throw new Error(`${label} is required`);
        return null;
      }
      try {
        return parseUsdToCents(s);
      } catch {
        throw new Error(`${label}: enter an amount like 2.49`);
      }
    };
    const barcodes = f.barcodes
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(\S+)(?:\s*x\s*(\d+))?$/i.exec(l);
        if (!m) throw new Error(`Barcode line “${l}”: use “barcode” or “barcode x24”`);
        return { barcode: m[1]!, pack_qty: m[2] ? Number(m[2]) : 1 };
      });
    const packQty = Number(f.pack_qty);
    if (f.sell_unit === 'pack' && (!Number.isInteger(packQty) || packQty < 2)) throw new Error('A pack needs 2 or more units');
    return {
      name: f.name.trim(),
      category_id: f.category_id || null,
      cash_price_cents: f.open_price ? (money('Cash price', f.cash, false) ?? 0) : money('Cash price', f.cash, true),
      card_price_cents: f.cardMode === 'custom' ? money('Card price', f.card, true) : null,
      cost_cents: money('Cost', f.cost, false),
      upc: f.upc.trim() || null,
      plu: f.plu.trim() || null,
      open_price: f.open_price,
      sell_unit: f.sell_unit,
      pack_qty: f.sell_unit === 'pack' ? packQty : 1,
      barcodes,
      active: f.active,
    };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = build();
    } catch (err) {
      return setError(err);
    }
    setBusy(true);
    try {
      const r = await api<{ catalog_version: number }>(item ? `${base}/items/${item.item_id}` : `${base}/items`, {
        method: item ? 'PATCH' : 'POST',
        body,
      });
      onSaved(`${item ? 'Saved' : 'Added'} “${f.name.trim()}” — catalog v${r.catalog_version}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{item ? `Edit “${item.name}”` : 'New item'}</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <form className="form-grid" onSubmit={submit}>
          <label className="field span2">
            Name
            <input value={f.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} autoFocus />
          </label>
          <label className="field span2">
            Category
            <select value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.category_id} value={c.category_id}>
                  {c.name}
                  {c.active ? '' : ' (hidden)'}
                </option>
              ))}
            </select>
          </label>

          <label className="check span2">
            <input type="checkbox" checked={f.open_price} onChange={(e) => set('open_price', e.target.checked)} /> Open price — the cashier
            types the price at the register (deli by weight, “misc grocery”)
          </label>

          <label className="field">
            Cash price {f.open_price && <span className="muted">(optional default)</span>}
            <span className="prefix-input">
              $<input value={f.cash} onChange={(e) => set('cash', e.target.value)} inputMode="decimal" placeholder="2.49" />
            </span>
          </label>
          <label className="field">
            Cost <span className="muted">(for margin)</span>
            <span className="prefix-input">
              $<input value={f.cost} onChange={(e) => set('cost', e.target.value)} inputMode="decimal" placeholder="1.20" />
            </span>
          </label>

          <fieldset className="span2">
            <legend>Card price</legend>
            <label className="check">
              <input type="radio" checked={f.cardMode === 'auto'} onChange={() => set('cardMode', 'auto')} /> Automatic: cash + {ppmToPercent(dualRate)}%
              {autoCard !== null && (
                <strong>
                  {' '}
                  = <Money cents={autoCard} />
                </strong>
              )}{' '}
              <span className="muted">at this location</span>
            </label>
            <label className="check">
              <input type="radio" checked={f.cardMode === 'custom'} onChange={() => set('cardMode', 'custom')} /> Fixed card price (same at every
              location — e.g. lottery at face value)
            </label>
            {f.cardMode === 'custom' && (
              <span className="prefix-input">
                $<input value={f.card} onChange={(e) => set('card', e.target.value)} inputMode="decimal" placeholder="2.59" />
              </span>
            )}
          </fieldset>

          <label className="field">
            UPC (main barcode)
            <input value={f.upc} onChange={(e) => set('upc', e.target.value)} className="mono" />
          </label>
          <label className="field">
            PLU
            <input value={f.plu} onChange={(e) => set('plu', e.target.value)} className="mono" placeholder="4011" />
          </label>

          <label className="field">
            Sold as
            <select value={f.sell_unit} onChange={(e) => set('sell_unit', e.target.value)}>
              <option value="each">single unit</option>
              <option value="pack">pack / case</option>
            </select>
          </label>
          {f.sell_unit === 'pack' && (
            <label className="field">
              Units per pack
              <input value={f.pack_qty} onChange={(e) => set('pack_qty', e.target.value)} inputMode="numeric" style={{ width: 80 }} />
            </label>
          )}

          <label className="field span2">
            More barcodes <span className="muted">— one per line; add “x24” for a case barcode that rings up 24</span>
            <textarea rows={3} value={f.barcodes} onChange={(e) => set('barcodes', e.target.value)} className="mono" />
          </label>

          <label className="check span2">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active (for sale on registers)
          </label>

          <div className="span2">
            <ErrorBox error={error} />
          </div>
          <div className="span2 actions-row">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Saving…' : item ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </form>

        {item && (
          <div className="history">
            <h3>Price history</h3>
            {history.data?.history.length ? (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th className="num">Cash</th>
                    <th className="num">Card</th>
                    <th className="num">Cost</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.history.map((h) => (
                    <tr key={h.history_id}>
                      <td>
                        <When at={h.changed_at} />
                      </td>
                      <td className="num">
                        <Money cents={h.cash_price_cents} />
                      </td>
                      <td className="num">{h.card_price_cents === null ? <span className="muted">auto</span> : <Money cents={h.card_price_cents} />}</td>
                      <td className="num">{h.cost_cents === null ? '—' : <Money cents={h.cost_cents} />}</td>
                      <td className="muted">{h.changed_by_name ?? h.changed_by_kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No price changes recorded yet.</p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
