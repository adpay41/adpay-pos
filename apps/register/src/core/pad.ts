/**
 * The register pad's digit entry (layout A, ADR 0045), like a till: digits fill from the cents
 * column (2-0-0-0 → $20.00), at most 7 digits ($99,999.99). Pure, so it's tested without the UI.
 */

/** Digits typed on the pad → cents. */
export const padCents = (digits: string): number => (digits ? Number(digits) : 0);

/** One key on the pad: a digit or 00, ⌫ (last digit off) or C (clear). Leading zeros never count. */
export const pressPad = (digits: string, key: string): string =>
  key === '⌫' ? digits.slice(0, -1) : key === 'C' ? '' : (digits + key).replace(/^0+/, '').slice(0, 7);
