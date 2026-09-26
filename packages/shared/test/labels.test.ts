import { describe, expect, it } from 'vitest';
import {
  barcodeKind,
  CODE128_PATTERNS,
  code128Modules,
  decodePriceEmbedded,
  DEFAULT_LABEL_TEMPLATE,
  ean13CheckDigit,
  ean13Modules,
  inStoreUpc,
  LabelTemplateInput,
  priceEmbeddedUpc,
  tagContent,
  upcaModules,
  upcCheckDigit,
} from '../src';

describe('UPC-A and EAN-13', () => {
  it('check digits of well-known codes', () => {
    expect(upcCheckDigit('03600029145')).toBe(2); // 0 36000 29145 2
    expect(ean13CheckDigit('400638133393')).toBe(1); // 4 006381 333931
  });

  it('95 modules, guards in place, left digits odd parity, right digits even', () => {
    const m = upcaModules('036000291452');
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe('101');
    expect(m.slice(45, 50)).toBe('01010');
    expect(m.slice(92)).toBe('101');
    for (let i = 0; i < 6; i++) expect([...m.slice(3 + i * 7, 10 + i * 7)].filter((b) => b === '1').length % 2).toBe(1);
    for (let i = 0; i < 6; i++) expect([...m.slice(50 + i * 7, 57 + i * 7)].filter((b) => b === '1').length % 2).toBe(0);
    expect(ean13Modules('4006381333931')).toHaveLength(95);
    expect(() => upcaModules('036000291453')).toThrow();
  });

  it('knows a printed code’s symbology', () => {
    expect(barcodeKind('036000291452')).toBe('upca');
    expect(barcodeKind('4006381333931')).toBe('ean13');
    expect(barcodeKind('4011')).toBe('code128');
  });
});

describe('Code 128', () => {
  it('every symbol is 11 modules wide (stop 13), bars and spaces alternating', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((p, i) => expect([...p].reduce((a, b) => a + Number(b), 0), `value ${i}`).toBe(i === 106 ? 13 : 11));
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it('start B, data, check, stop', () => {
    const m = code128Modules('AD-42');
    expect(m).toHaveLength(11 * (1 + 5 + 1) + 13);
    expect(m.startsWith('11010010000')).toBe(true); // start B = 211214
    expect(m.endsWith('1100011101011')).toBe(true); // stop = 2331112
  });
});

describe('price-embedded labels for open-price items', () => {
  it('round-trips PLU and price, and survives an EAN-13 reader’s leading zero', () => {
    const code = priceEmbeddedUpc('4101', 749);
    expect(code).toMatch(/^204101007490\d$|^2041010074\d{2}$/);
    expect(code).toHaveLength(12);
    expect(decodePriceEmbedded(code)).toEqual({ plu: '4101', price_cents: 749 });
    expect(decodePriceEmbedded(`0${code}`)).toEqual({ plu: '4101', price_cents: 749 });
    expect(decodePriceEmbedded('036000291452')).toBeNull();
    expect(() => priceEmbeddedUpc('4101', 100_000)).toThrow();
  });

  it('in-store codes are valid UPC-A in number system 4', () => {
    const c = inStoreUpc(17);
    expect(c.startsWith('40000000017')).toBe(true);
    expect(barcodeKind(c)).toBe('upca');
  });
});

describe('tag content', () => {
  it('both prices by default; the card price can be turned off; barcode when there is one', () => {
    const item = { name: 'Red Bull 8.4 oz', category: 'Drinks', cash_price_cents: 349, card_price_cents: 363, barcode: { kind: 'upca' as const, data: '036000291452' } };
    expect(tagContent(item, DEFAULT_LABEL_TEMPLATE)).toMatchObject({ title: 'Red Bull 8.4 oz', cash: '$3.49', card: '$3.63', note: 'Cash price · Card price', barcode: { text: '036000291452' } });
    const t = LabelTemplateInput.parse({ name: 'Cash only', size: 'thermal_2x1', show_card_price: false, show_barcode: false });
    expect(tagContent(item, t)).toMatchObject({ card: null, barcode: null });
  });
});

describe('scanning a price label at the register', () => {
  it('finds the item by PLU and carries the printed price', async () => {
    const { barcodeIndex, lookupBarcode } = await import('../src');
    const item = {
      item_id: 'i1', category_id: null, name: 'Turkey club', sku: null, upc: null, plu: '4101', barcodes: [], cash_price_cents: 899, card_price_cents: 935,
      card_price_override: false, open_price: true, cost_cents: null, taxable: true, tax_rate_ppm: 66_250, min_age: null, sell_unit: 'each' as const, pack_qty: 1,
      active: true, color: null, image_url: null, sort: 0,
    };
    const hit = lookupBarcode(barcodeIndex({ items: [item] }), priceEmbeddedUpc('4101', 749));
    expect(hit).toMatchObject({ matched: 'price_label', price_cents: 749, qty: 1 });
    expect(hit?.item.name).toBe('Turkey club');
    expect(lookupBarcode(barcodeIndex({ items: [item] }), priceEmbeddedUpc('4102', 749))).toBeNull();
  });
});
