/**
 * Generic catalog CSV import (build plan P14, Bible 3.1 "catalog import"). ADR 0023.
 *
 * Any spreadsheet export with a header row: the columns are recognised by common names (NRS,
 * Clover and Square exports use variations of these), so a store can switch without retyping.
 * Parsers for each system's exact format wait for sample files (⛔). Dollars are parsed as decimal
 * strings into integer cents: never a float.
 */
import { parseUsdToCents } from './money';

export interface ImportRow {
  line: number;
  name: string;
  category: string | null;
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  upc: string | null;
  plu: string | null;
  sku: string | null;
}

export interface ImportParse {
  rows: ImportRow[];
  errors: { line: number; message: string }[];
  /** Which of our fields each recognised column fed, for the preview. */
  columns: Partial<Record<keyof Omit<ImportRow, 'line'>, string>>;
}

export const IMPORT_MAX_ROWS = 5_000;

/** RFC 4180-style: commas, double-quoted fields, "" inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A byte-order mark (Excel on Windows adds one) is not part of the first header.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((f) => f.trim() !== ''));
}

const HEADERS: Record<keyof Omit<ImportRow, 'line'>, RegExp> = {
  name: /^(item ?name|name|description|item|product( name)?|title)$/i,
  category: /^(category|department|dept|group|category name)$/i,
  cash_price_cents: /^(price|cash price|retail( price)?|unit price|sell price|regular price)$/i,
  card_price_cents: /^(card price|credit price)$/i,
  cost_cents: /^(cost|unit cost|default cost|vendor cost)$/i,
  upc: /^(upc|barcode|ean|gtin|upc ?code|scan ?code)$/i,
  plu: /^(plu|plu code)$/i,
  sku: /^(sku|item ?(number|#|no\.?)|code)$/i,
};

const money = (v: string): number | null => {
  const t = v.trim().replace(/^\$/, '').replace(/,/g, '');
  return t === '' ? null : parseUsdToCents(t);
};

export function parseCatalogCsv(text: string): ImportParse {
  const table = parseCsv(text);
  const errors: ImportParse['errors'] = [];
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: 'Needs a header row and at least one item' }], columns: {} };
  const header = table[0]!.map((h) => h.trim());
  const index: Partial<Record<keyof typeof HEADERS, number>> = {};
  const columns: ImportParse['columns'] = {};
  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    const i = header.findIndex((h) => HEADERS[key].test(h));
    if (i >= 0) {
      index[key] = i;
      columns[key] = header[i]!;
    }
  }
  if (index.name === undefined || index.cash_price_cents === undefined) {
    return { rows: [], errors: [{ line: 1, message: 'The header needs a name column (Name / Description / Item) and a price column (Price / Retail)' }], columns };
  }
  if (table.length - 1 > IMPORT_MAX_ROWS) errors.push({ line: 1, message: `Only the first ${IMPORT_MAX_ROWS} items are read` });

  const rows: ImportRow[] = [];
  for (const [n, cells] of table.slice(1, IMPORT_MAX_ROWS + 1).entries()) {
    const line = n + 2;
    const cell = (k: keyof typeof HEADERS) => (index[k] === undefined ? '' : (cells[index[k]!] ?? '').trim());
    try {
      const name = cell('name');
      if (!name) throw new Error('No name');
      if (name.length > 120) throw new Error('Name longer than 120 characters');
      const cash = money(cell('cash_price_cents'));
      if (cash === null) throw new Error('No price');
      if (cash < 0) throw new Error('Negative price');
      const upc = cell('upc').replace(/\s/g, '') || null;
      if (upc && !/^[0-9A-Za-z-]{4,32}$/.test(upc)) throw new Error(`Barcode "${upc}" isn't 4–32 letters/digits`);
      const plu = cell('plu') || null;
      if (plu && !/^\d{3,6}$/.test(plu)) throw new Error(`PLU "${plu}" isn't 3–6 digits`);
      rows.push({
        line,
        name,
        category: cell('category').slice(0, 60) || null,
        cash_price_cents: cash,
        card_price_cents: money(cell('card_price_cents')),
        cost_cents: money(cell('cost_cents')),
        upc,
        plu,
        sku: cell('sku').slice(0, 40) || null,
      });
    } catch (e) {
      errors.push({ line, message: (e as Error).message.replace(/^not a dollar amount: /, 'Not a dollar amount: ') });
    }
  }
  return { rows, errors, columns };
}
