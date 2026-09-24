/**
 * Vertical packs: features are modules enabled per merchant by config, all in one build.
 * v1 enables `cstore`; `liquor`, `restaurant` and `grocery` are stubs with the interface defined, so
 * enabling one must leave everything booting (spec acceptance). Nothing in the core may assume
 * `cstore` is the only vertical.
 */
export const PACK_IDS = ['cstore', 'liquor', 'restaurant', 'grocery'] as const;
export type PackId = (typeof PACK_IDS)[number];

export interface VerticalPack {
  id: PackId;
  label: string;
  /** False for stubs: the pack can be enabled without error but contributes nothing yet. */
  implemented: boolean;
  /** Default quick-key categories the setup flow offers a new merchant. */
  defaultCategories: readonly { name: string; taxable: boolean; min_age: number | null }[];
}

export const PACKS: Record<PackId, VerticalPack> = {
  cstore: {
    id: 'cstore',
    label: 'Convenience store',
    implemented: true,
    defaultCategories: [
      { name: 'Sandwiches', taxable: true, min_age: null },
      { name: 'Drinks', taxable: true, min_age: null },
      { name: 'Snacks', taxable: true, min_age: null },
      { name: 'Tobacco', taxable: false, min_age: 21 },
      { name: 'Lottery', taxable: false, min_age: 18 },
      { name: 'Grocery', taxable: false, min_age: null },
    ],
  },
  liquor: { id: 'liquor', label: 'Liquor', implemented: false, defaultCategories: [] },
  restaurant: { id: 'restaurant', label: 'Restaurant', implemented: false, defaultCategories: [] },
  grocery: { id: 'grocery', label: 'Grocery', implemented: false, defaultCategories: [] },
};

export function isPackId(value: string): value is PackId {
  return (PACK_IDS as readonly string[]).includes(value);
}
