/**
 * Register speed (build plan P5 / F4, Bible 1.1): barcode lookup, item search, and the
 * keyboard-wedge scanner decoder. Pure functions, so the register, the tests and (later) the
 * Kotlin scanner bridge all agree on what a scan means.
 */
import type { CatalogItem, CatalogSnapshot } from './api';
import { decodePriceEmbedded } from './labels';

// ─────────────────────────────────────────────────────────── barcodes ──

/**
 * The same product barcode is written several ways: UPC-A (12 digits), EAN-13 (13, a UPC-A with a
 * leading 0), GTIN-14 (14, with packaging-level zeros). Compare on the digits without leading
 * zeros, so a UPC printed on a label and one typed into the catalog match. Non-numeric codes
 * (store-made labels) compare as typed, case-insensitively.
 */
export function barcodeKey(code: string): string {
  const t = code.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+/, '') || '0';
  return t.toUpperCase();
}

export interface ScanMatch {
  item: CatalogItem;
  /** Units to ring: a case barcode rings its pack quantity (Bible 1.1 "scan a case barcode = pack qty"). */
  qty: number;
  matched: 'upc' | 'barcode' | 'plu' | 'price_label';
  /** A price-embedded label (P21): ring at this cash price instead of asking. */
  price_cents?: number;
}

/** Index a catalog's barcodes once per snapshot; lookups are then O(1). */
export function barcodeIndex(snapshot: Pick<CatalogSnapshot, 'items'>): Map<string, ScanMatch> {
  const index = new Map<string, ScanMatch>();
  for (const item of snapshot.items) {
    if (!item.active) continue;
    // PLUs first so a real barcode wins if one ever collides with a short PLU.
    if (item.plu) index.set(`plu:${item.plu}`, { item, qty: 1, matched: 'plu' });
    for (const b of item.barcodes ?? []) index.set(barcodeKey(b.barcode), { item, qty: b.pack_qty, matched: 'barcode' });
    if (item.upc) index.set(barcodeKey(item.upc), { item, qty: 1, matched: 'upc' });
  }
  return index;
}

/** What a scanned or typed code rings up, or null for an unknown barcode. */
export function lookupBarcode(index: Map<string, ScanMatch>, code: string): ScanMatch | null {
  const t = code.trim();
  if (!t) return null;
  // A store-printed price label ("2" + PLU + price, P21): the item by its PLU, at the printed price.
  const label = decodePriceEmbedded(t);
  if (label) {
    const byPlu = index.get(`plu:${label.plu}`);
    if (byPlu) return { item: byPlu.item, qty: 1, matched: 'price_label', price_cents: label.price_cents };
  }
  return index.get(barcodeKey(t)) ?? (/^\d{3,6}$/.test(t) ? (index.get(`plu:${t}`) ?? null) : null);
}

// ─────────────────────────────────────────────────────────── search ──

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Levenshtein distance, stopping early once it exceeds `max` (search only needs "0, 1 or too far"). */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/**
 * Score how well one query word matches a name word: 3 exact, 2 prefix ("cok" → "coke"), 1 fuzzy
 * (one typo, for words of 4+ letters: "zro" → "zero", "marlbro" → "marlboro"), 0 no match.
 */
function wordScore(q: string, w: string, fuzzy = true): number {
  if (w === q) return 3;
  if (w.startsWith(q)) return 2;
  // One typo leaves one of the first two letters in place (or shifted by one): a cheap check that
  // skips the edit-distance work for almost every word on a 9,000-item catalog.
  if (!fuzzy || q.length < 3) return 0;
  if (q[0] !== w[0] && q[1] !== w[1] && q[0] !== w[1] && q[1] !== w[0]) return 0;
  if (within(q, w.slice(0, q.length + 1), 1) || within(q, w, 1)) return 1;
  return 0;
}

export interface SearchHit {
  item: CatalogItem;
  score: number;
  /** What matched: a whole barcode, the end of one, the PLU, or the name. */
  match: 'barcode' | 'barcode_end' | 'plu' | 'name';
  /**
   * The code to show with the result, so a person can read back what the item carries: the barcode
   * or PLU that matched, else the item's own barcode (null when it has none).
   */
  code: string | null;
}

/** Per item, worked out once per catalog object: its name's words and all its barcodes. */
const prepared = new WeakMap<CatalogItem, { words: string[]; codes: string[]; keys: string[] }>();
function prep(item: CatalogItem) {
  let p = prepared.get(item);
  if (!p) {
    const codes = [item.upc, ...(item.barcodes ?? []).map((b) => b.barcode)].filter((c): c is string => !!c);
    p = { words: words(item.name), codes, keys: codes.map(barcodeKey) };
    prepared.set(item, p);
  }
  return p;
}

/**
 * How typed digits match an item's barcodes (its UPC and any extra barcode): the whole code (UPC-A
 * and EAN-13 with a leading 0 are the same code), or its last 4+ digits. Null when neither.
 */
export function barcodeMatch(item: CatalogItem, query: string): { kind: 'barcode' | 'barcode_end'; code: string } | null {
  const q = query.trim();
  if (!/^\d{3,}$/.test(q)) return null;
  const { codes, keys } = prep(item);
  const key = barcodeKey(q);
  const i = keys.indexOf(key);
  if (i >= 0) return { kind: 'barcode', code: codes[i]! };
  if (q.length >= 4) {
    const end = codes.find((c) => c.endsWith(q));
    if (end) return { kind: 'barcode_end', code: end };
  }
  return null;
}

/**
 * Search by name (prefix / first letters / one-typo fuzzy: "coke zro" finds "Coke Zero 20 oz"),
 * by UPC or any barcode (the whole code, or its last 4+ digits: a damaged label can be typed), or by
 * PLU. Every query word must match some word of the name. A whole barcode or PLU ranks first, then
 * barcode endings, then names; ties alphabetical. Each item's words and codes are worked out once per
 * catalog, so typing stays fast on a 9,000-item price book.
 */
export function searchCatalog(snapshot: Pick<CatalogSnapshot, 'items'>, query: string, limit = 24): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const digits = /^\d{3,}$/.test(q);
  const qWords = words(q);
  for (const item of snapshot.items) {
    if (!item.active) continue;
    const p = prep(item);
    if (digits) {
      const bc = barcodeMatch(item, q);
      if (bc?.kind === 'barcode') {
        hits.push({ item, score: 100, match: 'barcode', code: bc.code });
        continue;
      }
      if (item.plu === q) {
        hits.push({ item, score: 99, match: 'plu', code: item.plu });
        continue;
      }
      if (bc) {
        hits.push({ item, score: 50, match: 'barcode_end', code: bc.code });
        continue;
      }
    }
    if (!qWords.length) continue;
    let total = 0;
    for (const qw of qWords) {
      let best = 0;
      for (const nw of p.words) {
        // Digits typed are a code or a size ("20 oz"): matched whole or as a prefix, never fuzzily.
        const sc = wordScore(qw, nw, !digits);
        if (sc > best) best = sc;
        if (best === 3) break;
      }
      if (best === 0) {
        total = 0;
        break;
      }
      total += best;
    }
    // Initials: "bec" → "Bacon Egg & Cheese".
    if (total === 0 && qWords.length === 1 && qWords[0]!.length >= 2) {
      const initials = p.words.map((w) => w[0]).join('');
      if (initials.startsWith(qWords[0]!)) total = 2;
    }
    if (total > 0) hits.push({ item, score: total, match: 'name', code: p.codes[0] ?? null });
  }
  return hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, limit);
}

// ─────────────────────────────────────────────────────────── keyboard wedge ──

/**
 * A USB or Bluetooth barcode scanner in "keyboard wedge" mode types the code and presses Enter,
 * far faster than a person. The decoder watches key timing and emits a scan when a burst of
 * characters ends in Enter. The same scanner works in the browser build today, and on the T2s the
 * HID scanner does the same.
 */
export class WedgeDecoder {
  private buf = '';
  private last = 0;
  private gaps: number[] = [];

  constructor(
    private readonly opts: { minLength: number; maxGapMs: number } = { minLength: 4, maxGapMs: 50 },
  ) {}

  /**
   * Feed one key (`key` as in KeyboardEvent.key) with its timestamp in ms. Returns the scanned code
   * when Enter completes a fast burst, otherwise null. A slow key starts a new burst.
   */
  feed(key: string, at: number): string | null {
    if (key === 'Enter') {
      const code = this.buf;
      const fast = this.gaps.length > 0 && this.gaps.every((g) => g <= this.opts.maxGapMs);
      this.reset();
      return code.length >= this.opts.minLength && fast ? code : null;
    }
    if (key.length !== 1) return null; // Shift, Tab, arrows…
    if (this.buf && at - this.last > this.opts.maxGapMs) this.reset();
    if (this.buf) this.gaps.push(at - this.last);
    this.buf += key;
    this.last = at;
    return null;
  }

  reset() {
    this.buf = '';
    this.gaps = [];
  }
}
