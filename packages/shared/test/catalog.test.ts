import { describe, expect, it } from 'vitest';
import {
  CatalogOrderInput,
  ItemCreateInput,
  LocationRatesInput,
  MAX_QUICK_KEYS,
  QuickKeysInput,
  TILE_COLORS,
  TileColorInput,
  categoryKeys,
  favoriteKeys,
  percentToPpm,
  ppmToPercent,
  type CatalogItem,
} from '../src';

describe('percent <-> ppm (no floats)', () => {
  it('parses typed percentages exactly', () => {
    expect(percentToPpm('4')).toBe(40_000);
    expect(percentToPpm('6.625')).toBe(66_250);
    expect(percentToPpm(' 8.875 % ')).toBe(88_750);
    expect(percentToPpm('0.1')).toBe(1_000);
    expect(() => percentToPpm('4.00001')).toThrow();
    expect(() => percentToPpm('four')).toThrow();
  });

  it('round-trips for display', () => {
    for (const p of [0, 1_000, 35_000, 40_000, 66_250, 88_750]) expect(percentToPpm(ppmToPercent(p))).toBe(p);
    expect(ppmToPercent(66_250)).toBe('6.625');
    expect(ppmToPercent(40_000)).toBe('4');
  });
});

describe('catalog input validation', () => {
  it('fills defaults and rejects float money', () => {
    const ok = ItemCreateInput.parse({ name: ' Coffee ', category_id: null, cash_price_cents: 225 });
    expect(ok).toMatchObject({ name: 'Coffee', card_price_cents: null, open_price: false, sell_unit: 'each', pack_qty: 1, barcodes: [] });
    expect(() => ItemCreateInput.parse({ name: 'X', category_id: null, cash_price_cents: 2.25 })).toThrow();
  });

  it('requires pack_qty 1 unless sold as a pack', () => {
    expect(() => ItemCreateInput.parse({ name: 'X', category_id: null, cash_price_cents: 100, pack_qty: 12 })).toThrow();
    expect(ItemCreateInput.parse({ name: 'X', category_id: null, cash_price_cents: 100, sell_unit: 'pack', pack_qty: 12 }).pack_qty).toBe(12);
  });

  it('rejects unknown fields, so nothing unexpected reaches the database', () => {
    expect(() => ItemCreateInput.parse({ name: 'X', category_id: null, cash_price_cents: 100, merchant_id: 'someone-else' })).toThrow();
  });

  it('caps the card-price markup at 10%', () => {
    expect(() => LocationRatesInput.parse({ dual_price_rate_ppm: 100_001 })).toThrow();
    expect(LocationRatesInput.parse({ dual_price_rate_ppm: 40_000 })).toEqual({ dual_price_rate_ppm: 40_000 });
    expect(() => LocationRatesInput.parse({})).toThrow();
  });
});

describe('quick keys', () => {
  const base = { category_id: 'c1', active: true, sort: 0 } as const;
  const item = (item_id: string, name: string, extra: Partial<CatalogItem> = {}) => ({ ...base, item_id, name, ...extra }) as CatalogItem;

  it('the tile palette has no red or green, and every stripe is a dark color that reads on white', () => {
    for (const [key, c] of Object.entries(TILE_COLORS)) {
      expect(key).not.toMatch(/red|green/);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.stripe.slice(i, i + 2), 16)) as [number, number, number];
      expect(r > 150 && g < 90 && b < 90, `${key} stripe looks red`).toBe(false);
      expect(g > 120 && r < 100 && b < 100, `${key} stripe looks green`).toBe(false);
    }
    expect(TileColorInput.safeParse('red').success).toBe(false);
    expect(TileColorInput.safeParse('blue').success).toBe(true);
  });

  it('category keys follow sort, then name; inactive items drop out', () => {
    const items = [item('a', 'Zeta', { sort: 1 }), item('b', 'Alpha', { sort: 1 }), item('c', 'Mid', { sort: 0 }), item('d', 'Gone', { active: false })];
    expect(categoryKeys({ items }, 'c1').map((i) => i.item_id)).toEqual(['c', 'b', 'a']);
  });

  it('favorites keep the merchant order and skip inactive or unknown ids', () => {
    const items = [item('a', 'A'), item('b', 'B', { active: false }), item('c', 'C')];
    expect(favoriteKeys({ items, quick_keys: ['c', 'b', 'zzz', 'a'] }).map((i) => i.item_id)).toEqual(['c', 'a']);
  });

  it('favorites and reorder inputs reject duplicates and cap the list', () => {
    const id = '0f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11';
    expect(QuickKeysInput.safeParse({ item_ids: [id, id] }).success).toBe(false);
    expect(QuickKeysInput.safeParse({ item_ids: Array.from({ length: MAX_QUICK_KEYS + 1 }, () => crypto.randomUUID()) }).success).toBe(false);
    expect(CatalogOrderInput.safeParse({}).success).toBe(false);
  });
});
