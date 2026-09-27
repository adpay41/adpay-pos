/**
 * Named key pages (NRS gap, ADR 0047): the owner's own tabs of keys on the register ("In-Store",
 * "Deli", "Coffee"), per store, in order, after ★ Favorites and before the departments. A key is an
 * item, or a department with a fixed amount (their "$10", "Medicine $2.00" keys; no amount = ask).
 * Pages are configuration, carried in the catalog snapshot and replaced as a whole on each save.
 */
import { z } from 'zod';

export const KEY_PAGES_MAX = 12;
export const PAGE_KEYS_MAX = 60;

export const PageKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('item'), item_id: z.uuid() }),
  z.strictObject({
    kind: z.literal('department'),
    category_id: z.uuid(),
    /** Rung at this amount; null asks for the price each time. */
    amount_cents: z.int().min(1).max(1_000_000).nullable(),
    /** What the key says; null = the department's name. */
    label: z.string().trim().min(1).max(24).nullable().default(null),
  }),
]);
export type PageKey = z.infer<typeof PageKeySchema>;

export const KeyPageInput = z.strictObject({
  name: z.string().trim().min(1).max(24),
  keys: z.array(PageKeySchema).max(PAGE_KEYS_MAX),
});

export const KeyPagesInput = z
  .strictObject({ pages: z.array(KeyPageInput).max(KEY_PAGES_MAX) })
  .refine((v) => new Set(v.pages.map((p) => p.name.toLowerCase())).size === v.pages.length, { message: 'Two pages have the same name', path: ['pages'] });
export type KeyPagesInputT = z.infer<typeof KeyPagesInput>;

export interface KeyPage {
  page_id: string;
  name: string;
  keys: PageKey[];
}
