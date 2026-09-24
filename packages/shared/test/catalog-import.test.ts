import { describe, expect, it } from 'vitest';
import { CATALOG_TEMPLATES, parseCatalogCsv, parseCsv } from '../src';

describe('CSV reading', () => {
  it('handles quotes, embedded commas and quotes, CRLF, a BOM and blank lines', () => {
    expect(parseCsv(String.fromCharCode(0xfeff) + 'a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
  });
});

describe('catalog CSV import', () => {
  it('recognises common column names and parses dollars to cents without floats', () => {
    const p = parseCatalogCsv('Item Name,Department,Retail Price,Cost,UPC,Card Price\nCoke 20oz,Drinks,$2.79,1.10,012000001291,2.90\n"Chips, BBQ",Snacks,1.5,,,\n');
    expect(p.errors).toEqual([]);
    expect(p.columns).toMatchObject({ name: 'Item Name', category: 'Department', cash_price_cents: 'Retail Price', cost_cents: 'Cost', upc: 'UPC', card_price_cents: 'Card Price' });
    expect(p.rows).toEqual([
      { line: 2, name: 'Coke 20oz', category: 'Drinks', cash_price_cents: 279, card_price_cents: 290, cost_cents: 110, upc: '012000001291', plu: null, sku: null },
      { line: 3, name: 'Chips, BBQ', category: 'Snacks', cash_price_cents: 150, card_price_cents: null, cost_cents: null, upc: null, plu: null, sku: null },
    ]);
  });

  it('reports bad lines by number and keeps the good ones', () => {
    const p = parseCatalogCsv('name,price,plu\nGood,1.00,\n,2.00,\nNo price,,\nBad price,abc,\nBad PLU,1.00,12\n');
    expect(p.rows.map((r) => r.name)).toEqual(['Good']);
    expect(p.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(p.errors[2]!.message).toMatch(/Not a dollar amount/);
  });

  it('needs a name and a price column', () => {
    expect(parseCatalogCsv('sku,cost\n1,2\n').errors[0]!.message).toMatch(/name column/);
  });
});

describe('catalog templates', () => {
  it('the c-store starter has its categories, items at integer prices, and restrictions on tobacco and lottery', () => {
    const t = CATALOG_TEMPLATES.cstore_starter!;
    const items = t.categories.flatMap((c) => t.items[c.name] ?? []);
    expect(items.length).toBeGreaterThan(70);
    expect(items.every((i) => Number.isInteger(i.cash) && i.cash > 0)).toBe(true);
    expect(t.categories.find((c) => c.name === 'Tobacco')?.restriction).toBe('tobacco');
    expect(t.categories.find((c) => c.name === 'Lottery')?.restriction).toBe('lottery');
  });
});
