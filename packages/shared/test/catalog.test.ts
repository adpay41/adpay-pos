import { describe, expect, it } from 'vitest';
import { ItemCreateInput, LocationRatesInput, percentToPpm, ppmToPercent } from '../src';

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
