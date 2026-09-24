/**
 * Demo seed data. The catalog itself is the c-store starter template in packages/shared (P14), so
 * the demo store and a merchant who starts from the template see the same items.
 */
import { CSTORE_CATEGORIES as CATEGORIES, CSTORE_ITEMS as ITEMS } from '@adpay/shared';

export { CATEGORIES, ITEMS };
export type { SeedCategory, SeedItem } from '@adpay/shared';

/** Synthetic UPC-A with a valid check digit. Prefix 2 marks in-store codes, not real products. */
export function syntheticUpc(n: number): string {
  const body = `2${String(n).padStart(10, '0')}`;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < 11; i++) {
    const d = Number(body[i]);
    if (i % 2 === 0) odd += d;
    else even += d;
  }
  const check = (10 - ((odd * 3 + even) % 10)) % 10;
  return `${body}${check}`;
}
