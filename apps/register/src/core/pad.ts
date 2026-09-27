/**
 * The register pad's digit entry (layout A, ADR 0045), like a till: as an amount, digits fill from
 * the cents column (2-0-0-0 → $20.00), at most 7 digits ($99,999.99). The same digits are a count
 * for the @ key and a code for the PLU key (ADR 0047), so they're kept as typed, leading zeros too
 * (NRS PLUs like 09014). Pure, so it's tested without the UI.
 */

/** Digits typed on the pad → cents. */
export const padCents = (digits: string): number => (digits ? Number(digits) : 0);

/** One key on the pad: a digit or 00, ⌫ (last digit off) or C (clear). */
export const pressPad = (digits: string, key: string): string =>
  key === '⌫' ? digits.slice(0, -1) : key === 'C' ? '' : (digits + key).slice(0, 7);

/** The digits as a quantity for the @ key: 1–999, or null when that isn't a usable count. */
export function padQty(digits: string): number | null {
  const n = digits ? Number(digits) : 0;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

/** PLU codes to try for what was typed: as typed, then without leading zeros (4011 = 04011). */
export function pluCandidates(digits: string): string[] {
  if (!/^\d{1,7}$/.test(digits)) return [];
  const bare = digits.replace(/^0+/, '');
  return bare && bare !== digits ? [digits, bare] : [digits];
}

/**
 * The item a typed PLU rings (ADR 0047): the PLU as typed or without its leading zeros, then any
 * PLU that matches once both lose their leading zeros (9014 finds an NRS 09014), then the digits as a
 * barcode. Null when nothing matches.
 */
export function findByPlu<T>(index: ReadonlyMap<string, T>, digits: string, byBarcode: (code: string) => T | null): T | null {
  for (const c of pluCandidates(digits)) {
    const hit = index.get(`plu:${c}`);
    if (hit) return hit;
  }
  const bare = digits.replace(/^0+/, '');
  if (bare) {
    for (const [k, v] of index) if (k.startsWith('plu:') && k.slice(4).replace(/^0+/, '') === bare) return v;
  }
  return digits ? byBarcode(digits) : null;
}
