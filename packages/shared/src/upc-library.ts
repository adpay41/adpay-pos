/**
 * The global UPC library (Bible 3.4; P25c, ADR 0041): every real product barcode any store has in
 * its catalog, deduped on the barcode key (UPC-A = EAN-13 with a leading 0 = GTIN-14), with the name
 * most stores use. A store meeting an unknown barcode gets a suggestion instead of a blank form.
 *
 * Only real GTINs are shared: store-made codes (in-store 2-prefix, price-embedded labels,
 * restricted 04 / 02 ranges, anything with a bad check digit) never leave their store. A typical
 * price is shown only when at least `UPC_PRICE_MIN_STORES` stores sell it, so no one store's price
 * can be read off it. Seeding from a licensed UPC database is a separate, blocked item.
 */
export const UPC_PRICE_MIN_STORES = 3;

/** GTIN mod-10 check: weights 3,1,3,… from the digit left of the check digit. */
export function gtinCheckValid(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * A barcode that means the same product in every store: 8, 12, 13 or 14 digits with a valid check
 * digit, outside the in-store / restricted ranges (UPC-A starting 2 or 4; EAN-13 starting 02, 04 or
 * 20–29; coupons starting 5 / 99).
 */
export function isGlobalGtin(code: string): boolean {
  const c = code.trim();
  if (!/^\d+$/.test(c) || ![8, 12, 13, 14].includes(c.length) || !gtinCheckValid(c)) return false;
  const ean13 = c.length === 12 ? `0${c}` : c.length === 14 ? c.slice(1) : c;
  if (ean13.length === 13) {
    const p2 = ean13.slice(0, 2);
    if (p2 >= '20' && p2 <= '29') return false; // in-store / variable weight (EAN)
    if (p2 === '02' || p2 === '04' || p2 === '05') return false; // UPC-A number systems 2, 4, 5
    if (p2 === '99') return false; // coupons
  }
  return true;
}

/** Group names that differ only in case, spacing or punctuation ("Goya Adobo 8oz" = "GOYA adobo, 8 oz"). */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/(\d)\s+(oz|ml|l|g|kg|lb|ct|pk)\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface UpcSuggestion {
  barcode_key: string;
  /** The name most stores use. */
  name: string;
  /** Other spellings, most used first, with how many stores use each. */
  names: { name: string; stores: number }[];
  category: string | null;
  stores: number;
  /** Median cash price across stores, only with UPC_PRICE_MIN_STORES or more; null otherwise. */
  typical_cash_cents: number | null;
}

export interface UpcSighting {
  merchant_id: string;
  name: string;
  category: string | null;
  cash_price_cents: number;
}

/** Fold every store's listing of one barcode into the shared suggestion. */
export function foldSightings(barcodeKey: string, rows: readonly UpcSighting[]): UpcSuggestion | null {
  // One vote per store: a store listing the same barcode twice counts once (its first listing).
  const perStore = new Map<string, UpcSighting>();
  for (const r of rows) if (!perStore.has(r.merchant_id)) perStore.set(r.merchant_id, r);
  const listings = [...perStore.values()];
  if (!listings.length) return null;

  const groups = new Map<string, { display: Map<string, number>; stores: number }>();
  for (const l of listings) {
    const k = nameKey(l.name);
    const g = groups.get(k) ?? { display: new Map(), stores: 0 };
    g.stores++;
    g.display.set(l.name, (g.display.get(l.name) ?? 0) + 1);
    groups.set(k, g);
  }
  // Within a name, the spelling most stores use; on a tie, one that isn't shouted in capitals.
  const shouted = (s: string) => (s === s.toUpperCase() && /[A-Z]/.test(s) ? 1 : 0);
  const ranked = [...groups.values()]
    .map((g) => ({ name: [...g.display.entries()].sort((a, b) => b[1] - a[1] || shouted(a[0]) - shouted(b[0]) || a[0].localeCompare(b[0]))[0]![0], stores: g.stores }))
    .sort((a, b) => b.stores - a.stores || a.name.localeCompare(b.name));

  const cats = new Map<string, number>();
  for (const l of listings) if (l.category) cats.set(l.category, (cats.get(l.category) ?? 0) + 1);
  const category = [...cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  let typical: number | null = null;
  if (listings.length >= UPC_PRICE_MIN_STORES) {
    const prices = listings.map((l) => l.cash_price_cents).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    // Median; with an even count, the lower middle (integer cents, no averaging).
    typical = prices.length % 2 ? prices[mid]! : prices[mid - 1]!;
  }
  return { barcode_key: barcodeKey, name: ranked[0]!.name, names: ranked, category, stores: listings.length, typical_cash_cents: typical };
}
