import { describe, expect, it } from 'vitest';
import { foldSightings, gtinCheckValid, inStoreUpc, isGlobalGtin, nameKey, priceEmbeddedUpc } from '../src';

describe('global GTINs', () => {
  it('real product codes pass; store-made and bad codes never leave the store', () => {
    expect(gtinCheckValid('036000291452')).toBe(true); // UPC-A
    expect(isGlobalGtin('036000291452')).toBe(true);
    expect(isGlobalGtin('0036000291452')).toBe(true); // the same as EAN-13
    expect(isGlobalGtin('4006381333931')).toBe(true); // EAN-13
    expect(isGlobalGtin('96385074')).toBe(true); // EAN-8
    expect(isGlobalGtin('036000291453')).toBe(false); // bad check digit
    expect(isGlobalGtin(inStoreUpc(17))).toBe(false); // in-store 2-prefix
    expect(isGlobalGtin(priceEmbeddedUpc('01234', 499))).toBe(false); // deli price label
    expect(isGlobalGtin('2012345678903')).toBe(false); // EAN in-store range
    expect(isGlobalGtin('ABC-123')).toBe(false);
  });

  it('names that differ in case, spacing or punctuation are one name', () => {
    expect(nameKey('GOYA Adobo, 8 oz')).toBe(nameKey('Goya adobo 8oz'));
    expect(nameKey('Coke 20oz')).not.toBe(nameKey('Diet Coke 20oz'));
  });
});

describe('folding sightings', () => {
  const s = (merchant_id: string, name: string, cash: number, category: string | null = 'Drinks') => ({ merchant_id, name, category, cash_price_cents: cash });

  it('one vote per store; the most used name wins; typical price only from 3 stores', () => {
    const two = foldSightings('36000291452', [s('a', 'Coke 20oz', 249), s('a', 'Coke 20 oz (dup)', 1), s('b', 'COKE 20 OZ', 229)]);
    expect(two).toMatchObject({ stores: 2, typical_cash_cents: null, category: 'Drinks' });
    expect(two!.names).toHaveLength(1); // "Coke 20oz" and "COKE 20 OZ" are one name
    const four = foldSightings('36000291452', [s('a', 'Coke 20oz', 249), s('b', 'Coke 20oz', 229), s('c', 'Coca-Cola 20oz', 299), s('d', 'Coke 20oz', 259)]);
    expect(four).toMatchObject({ name: 'Coke 20oz', stores: 4, typical_cash_cents: 249 });
    expect(four!.names.map((n) => n.stores)).toEqual([3, 1]);
    expect(foldSightings('1', [])).toBeNull();
  });
});
