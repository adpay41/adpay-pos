/**
 * NRS price book migration (docs/nrs-migration-method.md, ADR 0043). Two inputs, one row shape:
 *
 * - **JSON (primary)**: the items the NRS portal's own price-book table loads, saved as an array of
 *   objects (`upc`, `plu`, `name`, `dept`, `cents`, `cost_cents`, the flags…). Barcodes are the real
 *   ones, so imported items scan from day one.
 * - **CSV (secondary)**: the portal's "Export" file. Its `Upc` column is encrypted
 *   (`="<hex>|<storeId>"`), so those items come in without a barcode; the hash is kept as the NRS
 *   key so re-importing the same export updates instead of duplicating, and the register attaches
 *   the real barcode on first scan.
 *
 * Everything we can't represent is still imported, and counted in `flags` for the preview and the
 * final report. Money arrives in cents already; nothing here goes through a float.
 */
import type { ImportRow } from './catalog-import';
import { parseCsv } from './catalog-import';
import { isGlobalGtin } from './upc-library';

export const NRS_MAX_ROWS = 20_000;

/** What we keep of NRS's own flags on the item (`items.attrs.nrs`), for later features and support. */
export interface NrsAttrs {
  ebt: boolean | null;
  by_weight: boolean;
  price_includes_tax: boolean;
  price_includes_fees: boolean;
  fee_multiplier: number;
  modifier: boolean;
  size: string | null;
  description: string | null;
  /** The encrypted UPC from a CSV export, the match key when there's no barcode. */
  key: string | null;
  /** NRS's short code when it isn't one we can ring (we take 3–6 digit PLUs). */
  short_code: string | null;
}

export interface NrsImportRow extends ImportRow {
  open_price: boolean;
  active: boolean;
  nrs: NrsAttrs;
  /** A pack whose single unit is another item: stock is counted on the unit (case-break). */
  unit_upc: string | null;
  unit_count: number | null;
}

export type NrsFormat = 'nrs-json' | 'nrs-csv';

export interface NrsDepartment {
  name: string;
  items: number;
  /** Our guess from the name; the owner confirms each one in the preview before importing. */
  taxable: boolean;
  min_age: number | null;
  restriction: 'tobacco' | 'vape' | 'alcohol' | null;
}

export type NrsFlagKey =
  | 'price_includes_tax'
  | 'price_includes_fees'
  | 'fee_multiplier'
  | 'by_weight'
  | 'open_price'
  | 'store_code'
  | 'no_barcode'
  | 'short_code'
  | 'cost_missing'
  | 'needs_review'
  | 'inactive'
  | 'ebt';

export interface NrsFlag {
  key: NrsFlagKey;
  label: string;
  count: number;
  /** Up to 8 item names, for the preview. */
  examples: string[];
}

export interface NrsParse {
  format: NrsFormat;
  total: number;
  rows: NrsImportRow[];
  errors: { line: number; message: string }[];
  departments: NrsDepartment[];
  barcodes: { global: number; store: number; none: number };
  flags: NrsFlag[];
  /** NRS one-click keys found (the JSON carries none; the CSV has `is_oneclick`). */
  quick_keys: number;
}

const FLAG_LABELS: Record<NrsFlagKey, string> = {
  price_includes_tax: 'Price already includes tax in NRS: we add tax on top by category, so check these shelf prices',
  price_includes_fees: 'Price already includes a fee (deposit etc.) in NRS: we add per-unit charges by tax class',
  fee_multiplier: 'Fee multiplier other than 1 (not carried over)',
  by_weight: 'Marked by-weight in NRS: rung per each here (no scale yet)',
  open_price: 'No price or variable price: imported as open price (cashier types the price)',
  store_code: 'Barcode in the in-store ranges (2 / 4 / 5 prefix) or with an odd check digit: scans here, never shared to the UPC library',
  no_barcode: 'No usable barcode: scan once on the register to attach it',
  short_code: 'NRS short code that isn\'t a 3–6 digit PLU (kept on the item, not ringable by typing)',
  cost_missing: 'No cost in NRS: margin reports count these as uncosted',
  needs_review: 'Name looks like a placeholder (fewer than 2 letters, e.g. "1", "A"): imported, rename it',
  inactive: 'Inactive in NRS: imported as inactive',
  ebt: 'EBT/SNAP eligible (kept on the item for when EBT tender arrives)',
};

// ─────────────────────────────────────────────────────────── departments ──

/** Suggested settings for an NRS department from its name. The owner confirms them in the preview. */
export function suggestDepartment(name: string): Omit<NrsDepartment, 'name' | 'items'> {
  const n = name.toLowerCase();
  const taxable = !/non[- ]?tax|no[- ]?tax|tax[- ]?exempt|exempt/.test(n);
  if (/vape|e-?cig|vapor/.test(n)) return { taxable, min_age: 21, restriction: 'vape' };
  if (/smoke|cigar|tobacco|cigarette|hookah/.test(n)) return { taxable, min_age: 21, restriction: 'tobacco' };
  if (/beer|wine|liquor|spirit|alcohol|malt/.test(n)) return { taxable, min_age: 21, restriction: 'alcohol' };
  return { taxable, min_age: null, restriction: null };
}

// ─────────────────────────────────────────────────────────── input shapes ──

/** One item as the NRS price-book table holds it (the portal's `pbitems` rows). */
export interface NrsJsonItem {
  upc?: string | null;
  plu?: string | null;
  /** Older name for `plu` in some captures. */
  upcorplu?: string | null;
  name?: string | null;
  desc?: string | null;
  size?: string | null;
  dept?: string | null;
  qty?: number | null;
  cents?: number | string | null;
  cost_cents?: number | string | null;
  cost_qty?: number | string | null;
  includes_taxes?: boolean | null;
  includes_fees?: boolean | null;
  fee_multiplier?: number | string | null;
  byweight?: boolean | null;
  isebt?: boolean | null;
  ismodifier?: boolean | null;
  variableprice?: boolean | null;
  unit_upc?: string | null;
  unit_count?: number | string | null;
  status?: number | null;
}

const int = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};
const yes = (v: unknown): boolean => v === true || v === 'y' || v === 'Y' || v === 1 || v === 'true';
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A byte-order mark (Excel, Notepad) is not part of the content. */
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Whether a file is an NRS export we read, and which one. */
export function detectNrsFormat(fileText: string): NrsFormat | null {
  const t = stripBom(fileText).trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return 'nrs-json';
  const header = t.slice(0, t.indexOf('\n') >>> 0 || 400).toLowerCase();
  if (/^upc,department,qty,cents/.test(header.replace(/"/g, ''))) return 'nrs-csv';
  return null;
}

export function parseNrsPricebook(fileText: string): NrsParse {
  const format = detectNrsFormat(fileText);
  if (format === 'nrs-json') {
    let data: unknown;
    try {
      data = JSON.parse(stripBom(fileText));
    } catch {
      return empty('nrs-json', 'Not valid JSON');
    }
    // The saved rows array, or a DataTables response ({ data: [...] }).
    const items = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data : null;
    if (!items) return empty('nrs-json', 'Expected a list of NRS items');
    return build('nrs-json', items.map((it, i) => ({ line: i + 1, item: (it ?? {}) as NrsJsonItem })), 0);
  }
  if (format === 'nrs-csv') {
    const table = parseCsv(fileText);
    const header = table[0]!.map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const c = {
      upc: col('upc'), dept: col('department'), qty: col('qty'), cents: col('cents'), incltaxes: col('incltaxes'), inclfees: col('inclfees'), name: col('name'),
      size: col('size'), ebt: col('ebt'), byweight: col('byweight'), fee: col('fee multiplier'), cost_qty: col('cost_qty'), cost_cents: col('cost_cents'),
      variable: col('variable_price'), unit_upc: col('unit_upc'), unit_count: col('unit_count'), oneclick: col('is_oneclick'),
    };
    let oneclick = 0;
    const rows = table.slice(1).map((cells, i) => {
      const at = (k: keyof typeof c) => (c[k] < 0 ? '' : (cells[c[k]] ?? '').trim());
      if (yes(at('oneclick'))) oneclick++;
      const item: NrsJsonItem = {
        upc: unExcel(at('upc')),
        name: at('name'),
        size: at('size') || null,
        dept: at('dept'),
        cents: at('cents'),
        cost_cents: at('cost_cents'),
        cost_qty: at('cost_qty'),
        includes_taxes: yes(at('incltaxes')),
        includes_fees: yes(at('inclfees')),
        fee_multiplier: at('fee') || '1',
        byweight: yes(at('byweight')),
        isebt: at('ebt') === '' ? null : yes(at('ebt')),
        variableprice: yes(at('variable')),
        unit_upc: unExcel(at('unit_upc')) || null,
        unit_count: at('unit_count') || null,
        status: 1,
      };
      return { line: i + 2, item };
    });
    return build('nrs-csv', rows, oneclick);
  }
  return empty('nrs-json', 'This isn\'t an NRS price book (JSON items or the portal\'s CSV export)');
}

/** `="0123"` is how the export stops Excel dropping leading zeros. */
function unExcel(v: string): string {
  const m = /^="(.*)"$/.exec(v);
  return (m ? m[1]! : v).trim();
}

function empty(format: NrsFormat, message: string): NrsParse {
  return { format, total: 0, rows: [], errors: [{ line: 1, message }], departments: [], barcodes: { global: 0, store: 0, none: 0 }, flags: [], quick_keys: 0 };
}

function build(format: NrsFormat, input: { line: number; item: NrsJsonItem }[], quickKeys: number): NrsParse {
  const errors: NrsParse['errors'] = [];
  const rows: NrsImportRow[] = [];
  const flagged = new Map<NrsFlagKey, { count: number; examples: string[] }>();
  const flag = (key: NrsFlagKey, name: string) => {
    const f = flagged.get(key) ?? { count: 0, examples: [] };
    f.count++;
    if (f.examples.length < 8) f.examples.push(name);
    flagged.set(key, f);
  };
  const barcodes = { global: 0, store: 0, none: 0 };
  const depts = new Map<string, { name: string; items: number }>();
  const seenCode = new Map<string, number>();
  const seenPlu = new Map<string, number>();

  if (input.length > NRS_MAX_ROWS) errors.push({ line: 1, message: `Only the first ${NRS_MAX_ROWS} items are read` });
  for (const { line, item } of input.slice(0, NRS_MAX_ROWS)) {
    try {
      const name = (text(item.name) ?? text(item.desc) ?? '').replace(/\s+/g, ' ').slice(0, 120);
      if (!name) throw new Error('No name');
      const cents = int(item.cents);
      if (cents === null) throw new Error(`Price "${String(item.cents)}" isn't whole cents`);
      if (cents < 0) throw new Error('Negative price');

      // Barcode: digits are a real code; anything else from the CSV is NRS's encrypted UPC.
      const raw = text(item.upc) ?? '';
      let upc: string | null = null;
      let key: string | null = null;
      if (/^\d{6,14}$/.test(raw)) upc = raw;
      else if (raw) key = raw.slice(0, 200);
      if (upc) {
        const prev = seenCode.get(upc);
        if (prev !== undefined) throw new Error(`Barcode ${upc} is also on line ${prev}`);
        seenCode.set(upc, line);
        if (isGlobalGtin(upc)) barcodes.global++;
        else {
          barcodes.store++;
          flag('store_code', name);
        }
      } else {
        barcodes.none++;
        flag('no_barcode', name);
      }

      // NRS's "UPC or PLU" short code, when it's not just the barcode again.
      const short = text(item.plu) ?? text(item.upcorplu);
      let plu: string | null = null;
      let shortCode: string | null = null;
      if (short && short !== upc) {
        if (/^\d{3,6}$/.test(short) && !seenPlu.has(short)) {
          plu = short;
          seenPlu.set(short, line);
        } else {
          shortCode = short.slice(0, 20);
          flag('short_code', name);
        }
      }

      const costCents = int(item.cost_cents) ?? 0;
      const costQty = Math.max(1, int(item.cost_qty) ?? 1);
      const cost = costCents > 0 ? Math.round(costCents / costQty) : null;
      if (cost === null) flag('cost_missing', name);

      const variable = yes(item.variableprice);
      const openPrice = variable || cents === 0;
      if (openPrice) flag('open_price', name);
      const byWeight = yes(item.byweight);
      if (byWeight) flag('by_weight', name);
      const inclTax = yes(item.includes_taxes);
      if (inclTax) flag('price_includes_tax', name);
      const inclFees = yes(item.includes_fees);
      if (inclFees) flag('price_includes_fees', name);
      const feeMult = int(item.fee_multiplier) ?? 1;
      if (feeMult !== 1) flag('fee_multiplier', name);
      const ebt = item.isebt === null || item.isebt === undefined ? null : yes(item.isebt);
      if (ebt) flag('ebt', name);
      const active = item.status === null || item.status === undefined || item.status === 1;
      if (!active) flag('inactive', name);
      if (name.replace(/[^a-z]/gi, '').length < 2) flag('needs_review', name);

      const dept = (text(item.dept) ?? '').slice(0, 60) || null;
      if (dept) {
        const d = depts.get(dept.toLowerCase()) ?? { name: dept, items: 0 };
        d.items++;
        depts.set(dept.toLowerCase(), d);
      }
      const unitCount = int(item.unit_count);
      const desc = text(item.desc);

      rows.push({
        line,
        name,
        category: dept,
        cash_price_cents: cents,
        card_price_cents: null,
        cost_cents: cost,
        upc,
        plu,
        sku: null,
        open_price: openPrice,
        active,
        unit_upc: text(item.unit_upc),
        unit_count: unitCount !== null && unitCount > 1 ? unitCount : null,
        nrs: {
          ebt,
          by_weight: byWeight,
          price_includes_tax: inclTax,
          price_includes_fees: inclFees,
          fee_multiplier: feeMult,
          modifier: yes(item.ismodifier),
          size: text(item.size),
          description: desc && desc !== name ? desc.slice(0, 200) : null,
          key,
          short_code: shortCode,
        },
      });
    } catch (e) {
      errors.push({ line, message: (e as Error).message });
    }
  }

  const order: NrsFlagKey[] = ['price_includes_tax', 'price_includes_fees', 'fee_multiplier', 'by_weight', 'open_price', 'no_barcode', 'store_code', 'short_code', 'needs_review', 'inactive', 'cost_missing', 'ebt'];
  return {
    format,
    total: input.length,
    rows,
    errors,
    departments: [...depts.values()].sort((a, b) => b.items - a.items).map((d) => ({ ...d, ...suggestDepartment(d.name) })),
    barcodes,
    flags: order.filter((k) => flagged.has(k)).map((k) => ({ key: k, label: FLAG_LABELS[k], ...flagged.get(k)! })),
    quick_keys: quickKeys,
  };
}

// ─────────────────────────────────────────────────────────── preview / report ──

/** What `POST …/catalog/import/nrs` answers, for the merchant app and admin. */
export interface NrsImportResponse {
  parse: Omit<NrsParse, 'rows' | 'departments'> & { departments: (NrsDepartment & { exists: boolean })[]; error_count: number };
  result: {
    dry_run: boolean;
    created: number;
    updated: number;
    unchanged: number;
    categories_created: string[];
    packs_linked?: number;
    sample: { line: number | null; name: string; action: 'create' | 'update' | 'unchanged'; from_cents: number | null; to_cents: number }[];
  } | null;
}

/** The department settings the owner chose in the preview, as the import request takes them. */
export type NrsDepartmentChoices = Record<string, { taxable: boolean; min_age: number | null; restriction: 'tobacco' | 'vape' | 'alcohol' | null }>;

/**
 * The final report, in words, the same on every screen: how many items, categories and quick keys
 * came in, and what couldn't be carried over.
 */
export function nrsImportReport(r: NrsImportResponse): { headline: string; lines: string[]; unmapped: string[] } {
  const p = r.parse;
  const x = r.result;
  const verb = x?.dry_run === false ? 'Imported' : 'Will import';
  const headline = x
    ? `${verb} ${x.created + x.updated + x.unchanged} of ${p.total} items: ${x.created} new, ${x.updated} updated, ${x.unchanged} unchanged.`
    : `Nothing to import from this file.`;
  const existing = p.departments.filter((d) => d.exists).length;
  const lines = [
    `Categories: ${p.departments.length} NRS departments${x ? `, ${x.categories_created.length} new` : ''}${existing ? `, ${existing} already in your catalog (their tax and age settings kept)` : ''}.`,
    `Barcodes: ${p.barcodes.global} real product barcodes, ${p.barcodes.store} store codes, ${p.barcodes.none} without a barcode.`,
    p.quick_keys
      ? `Quick keys: ${p.quick_keys} NRS one-click keys found; set your favorites in Items → Favorites.`
      : 'Quick keys: 0 — the NRS file has no one-click keys, so set your favorites in Items → Favorites.',
  ];
  if (x?.packs_linked) lines.push(`Packs: ${x.packs_linked} packs tied to their single unit for stock.`);
  const unmapped = [
    ...(p.error_count ? [`${p.error_count} lines couldn't be read (${p.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join('; ')}${p.error_count > 3 ? '…' : ''})`] : []),
    ...p.flags.filter((f) => f.key !== 'ebt').map((f) => `${f.count} × ${f.label}`),
  ];
  return { headline, lines, unmapped };
}
