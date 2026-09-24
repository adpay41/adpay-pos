import { describe, expect, it } from 'vitest';
import { WedgeDecoder, barcodeIndex, barcodeKey, lookupBarcode, searchCatalog, type CatalogItem } from '../src';

let n = 0;
function item(name: string, extra: Partial<CatalogItem> = {}): CatalogItem {
  n++;
  return {
    item_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, category_id: null, name, sku: null, upc: null, plu: null,
    barcodes: [], cash_price_cents: 100, card_price_cents: 104, card_price_override: false, open_price: false, cost_cents: null,
    taxable: true, tax_rate_ppm: 0, min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
    ...extra,
  };
}

const coke = item('Coke Zero 20 oz', { upc: '049000042566' });
const marlboro = item('Marlboro Gold Pack', { upc: '028200003843', barcodes: [{ barcode: '028200003850', pack_qty: 10 }] });
const bananas = item('Bananas', { plu: '4011', open_price: true });
const bec = item('Bacon Egg & Cheese');
const gone = item('Coke Classic 12 oz', { upc: '049000000443', active: false });
const catalog = { items: [coke, marlboro, bananas, bec, gone] };

describe('barcodes', () => {
  it('treats UPC-A, EAN-13 and GTIN-14 forms of one code as the same', () => {
    expect(barcodeKey('049000042566')).toBe(barcodeKey('0049000042566'));
    expect(barcodeKey('00049000042566')).toBe(barcodeKey('49000042566'));
    expect(barcodeKey('abc-12')).toBe('ABC-12');
  });

  it('finds items by UPC (any form), by case barcode with its pack quantity, and by PLU', () => {
    const idx = barcodeIndex(catalog);
    expect(lookupBarcode(idx, '0049000042566')).toMatchObject({ item: { name: 'Coke Zero 20 oz' }, qty: 1, matched: 'upc' });
    expect(lookupBarcode(idx, '028200003850')).toMatchObject({ item: { name: 'Marlboro Gold Pack' }, qty: 10, matched: 'barcode' });
    expect(lookupBarcode(idx, '4011')).toMatchObject({ item: { name: 'Bananas' }, matched: 'plu' });
  });

  it('unknown and inactive items are not found', () => {
    const idx = barcodeIndex(catalog);
    expect(lookupBarcode(idx, '012345678905')).toBeNull();
    expect(lookupBarcode(idx, '049000000443')).toBeNull();
    expect(lookupBarcode(idx, '  ')).toBeNull();
  });
});

describe('search', () => {
  const names = (q: string) => searchCatalog(catalog, q).map((h) => h.item.name);

  it('matches word prefixes and first letters', () => {
    expect(names('cok')).toEqual(['Coke Zero 20 oz']);
    expect(names('marl gold')).toEqual(['Marlboro Gold Pack']);
    expect(names('bec')).toEqual(['Bacon Egg & Cheese']);
  });

  it('forgives one typo per word ("coke zro", "marlbro")', () => {
    expect(names('coke zro')).toEqual(['Coke Zero 20 oz']);
    expect(names('marlbro')).toEqual(['Marlboro Gold Pack']);
  });

  it('finds by PLU, by full UPC and by the last digits of a barcode', () => {
    expect(names('4011')).toEqual(['Bananas']);
    expect(names('49000042566')).toEqual(['Coke Zero 20 oz']);
    expect(names('3850')).toEqual(['Marlboro Gold Pack']);
  });

  it('every query word must match; inactive items never show', () => {
    expect(names('coke gold')).toEqual([]);
    expect(names('classic')).toEqual([]);
  });
});

describe('keyboard-wedge decoder', () => {
  const feedAll = (d: WedgeDecoder, s: string, start: number, gap: number) => {
    let out: string | null = null;
    [...s, 'Enter'].forEach((k, i) => {
      out = d.feed(k, start + i * gap) ?? out;
    });
    return out;
  };

  it('a fast burst ending in Enter is a scan', () => {
    expect(feedAll(new WedgeDecoder(), '049000042566', 1000, 8)).toBe('049000042566');
  });

  it('a person typing is not a scan', () => {
    expect(feedAll(new WedgeDecoder(), '4011', 1000, 180)).toBeNull();
  });

  it('too short is not a scan; a pause starts over', () => {
    const d = new WedgeDecoder();
    expect(feedAll(d, '12', 0, 5)).toBeNull();
    // typed "9" slowly, then a real scan: only the scan comes out
    d.feed('9', 0);
    expect(feedAll(d, '028200003850', 500, 6)).toBe('028200003850');
  });
});
