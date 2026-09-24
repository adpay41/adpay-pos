/**
 * Catalog templates (build plan P14, Bible 3.1 "catalog templates by vertical"): a merchant starts
 * from a ready catalog and edits prices instead of typing names. ADR 0023.
 *
 * The c-store starter is the NJ/NYC deli-grocery catalog the demo seed uses: names, categories and
 * suggested cash prices in integer cents (2026 street levels). It carries **no UPCs**: a licensed
 * UPC dataset (2,000 common c-store UPCs with sizes) is ⛔ a data licence. Brand names are ordinary
 * product descriptions.
 *
 * `card` sets an explicit posted card price (lottery at face value, cigarettes at one price);
 * omitted → derived from the location's dual-price rate. `weight` is popularity, used by the demo
 * sale simulator only.
 */
import { z } from 'zod';

export interface SeedCategory {
  name: string;
  taxable: boolean;
  min_age: number | null;
  /** The state's age rule applies on top of min_age (P10). */
  restriction?: 'tobacco' | 'vape' | 'alcohol' | 'lottery';
  color: string;
}

export interface SeedItem {
  name: string;
  cash: number;
  card?: number;
  /** Sold as a pack of `pack` units (case-break). */
  pack?: number;
  /** Relative popularity within its category. */
  weight?: number;
}

// Taxability follows the spec's cstore pack (lottery/tobacco carry the non-taxable flag) and NJ/NY
// treatment of unprepared food. Household goods are taxable. Confirm per-state rules before launch.
export const CSTORE_CATEGORIES: SeedCategory[] = [
  { name: 'Sandwiches', taxable: true, min_age: null, color: '#1f1f1f' },
  { name: 'Drinks', taxable: true, min_age: null, color: '#3a3a3a' },
  { name: 'Snacks', taxable: true, min_age: null, color: '#4d4d4d' },
  { name: 'Tobacco', taxable: false, min_age: 21, restriction: 'tobacco', color: '#262626' },
  { name: 'Lottery', taxable: false, min_age: 18, restriction: 'lottery', color: '#333333' },
  { name: 'Grocery', taxable: false, min_age: null, color: '#404040' },
  { name: 'Household', taxable: true, min_age: null, color: '#595959' },
];

export const CSTORE_ITEMS: Record<string, SeedItem[]> = {
  Sandwiches: [
    { name: 'Bacon, Egg & Cheese on a Roll', cash: 599, weight: 10 },
    { name: 'Pork Roll, Egg & Cheese', cash: 649, weight: 9 },
    { name: 'Sausage, Egg & Cheese', cash: 649, weight: 6 },
    { name: 'Egg & Cheese on a Roll', cash: 449, weight: 5 },
    { name: 'Buttered Roll', cash: 199, weight: 4 },
    { name: 'Chopped Cheese Hero', cash: 1099, weight: 7 },
    { name: 'Chicken Cutlet Hero', cash: 1249, weight: 6 },
    { name: 'Italian Combo Hero', cash: 1299, weight: 5 },
    { name: 'Turkey Club', cash: 1149, weight: 4 },
    { name: 'Tuna on Rye', cash: 899, weight: 3 },
    { name: 'BLT on Toast', cash: 799, weight: 3 },
    { name: 'Grilled Cheese', cash: 549, weight: 2 },
  ],
  Drinks: [
    { name: 'Hot Coffee — Small', cash: 175, weight: 8 },
    { name: 'Hot Coffee — Medium', cash: 225, weight: 10 },
    { name: 'Hot Coffee — Large', cash: 275, weight: 6 },
    { name: 'Iced Coffee — Large', cash: 350, weight: 4 },
    { name: 'Coca-Cola 20 oz', cash: 279, weight: 7 },
    { name: 'Diet Coke 20 oz', cash: 279, weight: 4 },
    { name: 'Sprite 20 oz', cash: 279, weight: 3 },
    { name: 'Spring Water 16.9 oz', cash: 149, weight: 8 },
    { name: 'Spring Water 1 L', cash: 229, weight: 3 },
    { name: 'Iced Tea 23 oz Can', cash: 149, weight: 5 },
    { name: 'Gatorade 28 oz', cash: 299, weight: 5 },
    { name: 'Red Bull 8.4 oz', cash: 349, weight: 4 },
    { name: 'Monster Energy 16 oz', cash: 369, weight: 4 },
    { name: 'Snapple 16 oz', cash: 269, weight: 3 },
    { name: 'Orange Juice 12 oz', cash: 299, weight: 2 },
    { name: 'Coca-Cola 12 oz Can', cash: 150, weight: 3 },
    { name: 'Coca-Cola 12 oz Cans — 12 Pack', cash: 1099, pack: 12, weight: 1 },
  ],
  Snacks: [
    { name: 'Doritos Nacho Cheese 2.75 oz', cash: 229, weight: 6 },
    { name: "Lay's Classic 2.6 oz", cash: 229, weight: 5 },
    { name: 'Takis Fuego 4 oz', cash: 279, weight: 5 },
    { name: 'Flamin’ Hot Cheetos 2.75 oz', cash: 229, weight: 5 },
    { name: 'Crab Chips 1 oz', cash: 149, weight: 2 },
    { name: 'Snickers', cash: 199, weight: 4 },
    { name: "Reese's Cups", cash: 199, weight: 4 },
    { name: 'Peanut M&M’s', cash: 199, weight: 3 },
    { name: 'Kit Kat', cash: 199, weight: 3 },
    { name: 'Butterscotch Krimpets', cash: 199, weight: 2 },
    { name: 'Honey Bun', cash: 149, weight: 3 },
    { name: 'Pringles Original', cash: 299, weight: 2 },
    { name: 'Salted Peanuts', cash: 199, weight: 1 },
    { name: 'Beef Stick', cash: 149, weight: 2 },
    { name: 'Chewing Gum', cash: 169, weight: 2 },
  ],
  Tobacco: [
    { name: 'Marlboro Red — Pack', cash: 1400, card: 1400, weight: 8 },
    { name: 'Marlboro Gold — Pack', cash: 1400, card: 1400, weight: 5 },
    { name: 'Newport Menthol — Pack', cash: 1450, card: 1450, weight: 8 },
    { name: 'Camel Blue — Pack', cash: 1375, card: 1375, weight: 3 },
    { name: 'Marlboro Red — Carton', cash: 13500, card: 13500, pack: 10, weight: 1 },
    { name: 'Cigarillos 2-Pack', cash: 199, weight: 4 },
    { name: 'Rolling Papers', cash: 199, weight: 2 },
  ],
  Lottery: [
    { name: 'Scratch-Off $1', cash: 100, card: 100, weight: 3 },
    { name: 'Scratch-Off $2', cash: 200, card: 200, weight: 3 },
    { name: 'Scratch-Off $5', cash: 500, card: 500, weight: 5 },
    { name: 'Scratch-Off $10', cash: 1000, card: 1000, weight: 4 },
    { name: 'Scratch-Off $20', cash: 2000, card: 2000, weight: 2 },
    { name: 'Powerball', cash: 200, card: 200, weight: 4 },
    { name: 'Mega Millions', cash: 500, card: 500, weight: 3 },
    { name: 'Pick-3', cash: 100, card: 100, weight: 2 },
  ],
  Grocery: [
    { name: 'Whole Milk — Gallon', cash: 499, weight: 6 },
    { name: 'Whole Milk — Half Gallon', cash: 329, weight: 5 },
    { name: 'Large Eggs — Dozen', cash: 449, weight: 5 },
    { name: 'White Bread Loaf', cash: 349, weight: 4 },
    { name: 'Banana', cash: 39, weight: 5 },
    { name: 'Instant Noodle Cup', cash: 149, weight: 4 },
    { name: 'Black Beans 15.5 oz', cash: 199, weight: 2 },
    { name: 'Adobo Seasoning', cash: 299, weight: 1 },
    { name: 'Long Grain Rice 2 lb', cash: 349, weight: 2 },
    { name: 'Butter 1 lb', cash: 599, weight: 2 },
    { name: 'Breakfast Cereal', cash: 549, weight: 2 },
    { name: 'Sliced American Cheese 1/2 lb', cash: 499, weight: 2 },
  ],
  Household: [
    { name: 'Paper Towels — Single Roll', cash: 299, weight: 3 },
    { name: 'Toilet Paper 4-Roll', cash: 599, weight: 3 },
    { name: 'Disposable Lighter', cash: 249, weight: 5 },
    { name: 'AA Batteries 4-Pack', cash: 699, weight: 2 },
    { name: 'Laundry Detergent Pods 12 ct', cash: 699, weight: 1 },
    { name: 'Phone Charging Cable', cash: 999, weight: 1 },
    { name: 'Trash Bags 10 ct', cash: 399, weight: 1 },
  ],
};

export interface CatalogTemplate {
  id: string;
  label: string;
  pack: 'cstore' | 'liquor' | 'restaurant' | 'grocery';
  description: string;
  categories: SeedCategory[];
  items: Record<string, SeedItem[]>;
}

export const CATALOG_TEMPLATES: Record<string, CatalogTemplate> = {
  cstore_starter: {
    id: 'cstore_starter',
    label: 'Deli & c-store starter (NJ/NYC)',
    pack: 'cstore',
    description: '7 categories, about 80 everyday items with suggested prices: breakfast sandwiches, coffee, drinks, snacks, tobacco, lottery, grocery, household.',
    categories: CSTORE_CATEGORIES,
    items: CSTORE_ITEMS,
  },
};

// ───────────────────────────────────────────────────────────────────────── the usual ──

/** A cashier's preset basket, "the usual" (Bible 1.1): one tap rings every line. */
export interface CashierUsual {
  usual_id: string;
  user_id: string;
  label: string;
  lines: { item_id: string; qty: number }[];
}

export const UsualInput = z.strictObject({
  user_id: z.uuid(),
  label: z.string().trim().min(1).max(40),
  lines: z
    .array(z.strictObject({ item_id: z.uuid(), qty: z.int().min(1).max(100) }))
    .min(1)
    .max(20),
});

/** How many usuals one cashier can keep, so the panel stays one screen. */
export const MAX_USUALS_PER_CASHIER = 12;
