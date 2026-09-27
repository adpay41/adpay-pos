/**
 * NRS price book parser (ADR 0043): the portal's items JSON and its CSV export, read into one row
 * shape with what can't be carried over counted. The store's full files run in the API tests.
 */
import { describe, expect, it } from 'vitest';
import { detectNrsFormat, nrsImportReport, parseNrsPricebook, suggestDepartment } from '../src/nrs-import';

const item = (over: Record<string, unknown>) => ({
  upc: '012000161155', plu: '012000161155', name: 'Pepsi 20oz', desc: 'Pepsi 20oz 20oz', size: '20oz', dept: 'Drinks', qty: 1, cents: 249,
  cost_cents: 0, cost_qty: 1, includes_taxes: false, includes_fees: false, fee_multiplier: 1, byweight: false, isebt: null, ismodifier: null,
  variableprice: false, unit_upc: null, unit_count: null, numpromos: 0, status: 1, item_groups: [], ...over,
});

describe('NRS price book parser', () => {
  it('reads the portal JSON: real barcode, short code as PLU, cost per unit, flags kept', () => {
    const p = parseNrsPricebook(
      JSON.stringify([
        item({ cost_cents: 1200, cost_qty: 12, isebt: true }),
        item({ upc: '209014000000', plu: '09014', name: 'Egg sandwich', dept: 'General food', cents: 450 }),
        item({ upc: '200000000004', plu: '00', name: 'FAFDA', dept: 'General food', cents: 0 }),
        item({ upc: '028200003843', plu: '028200003843', name: 'Marlboro Red', dept: 'all smoke', cents: 1399, includes_taxes: true, status: 0 }),
      ]),
    );
    expect(p).toMatchObject({ format: 'nrs-json', total: 4, errors: [], barcodes: { global: 2, store: 2, none: 0 } });
    expect(p.rows[0]).toMatchObject({ upc: '012000161155', plu: null, cost_cents: 100, open_price: false, nrs: { ebt: true, size: '20oz', description: 'Pepsi 20oz 20oz' } });
    expect(p.rows[1]).toMatchObject({ plu: '09014' });
    expect(p.rows[2]).toMatchObject({ plu: null, open_price: true, nrs: { short_code: '00' } });
    expect(p.rows[3]).toMatchObject({ active: false, nrs: { price_includes_tax: true } });
    const flags = Object.fromEntries(p.flags.map((f) => [f.key, f.count]));
    expect(flags).toMatchObject({ store_code: 2, short_code: 1, open_price: 1, price_includes_tax: 1, inactive: 1, cost_missing: 3 });
    expect(p.departments.find((d) => d.name === 'all smoke')).toMatchObject({ restriction: 'tobacco', min_age: 21 });
  });

  it('takes a DataTables response ({ data: [...] }), a byte-order mark, and upcorplu', () => {
    const p = parseNrsPricebook(String.fromCharCode(0xfeff) + JSON.stringify({ draw: 1, recordsTotal: 1, data: [item({ plu: undefined, upcorplu: '4011' })] }));
    expect(p.rows[0]).toMatchObject({ plu: '4011' });
  });

  it('reports bad lines and a barcode used twice, by line', () => {
    const p = parseNrsPricebook(JSON.stringify([item({}), item({ name: 'Pepsi again' }), item({ upc: '1', name: '', desc: null, cents: 100 }), item({ upc: '049000000443', cents: 'abc' })]));
    expect(p.rows).toHaveLength(1);
    expect(p.errors).toEqual([
      { line: 2, message: 'Barcode 012000161155 is also on line 1' },
      { line: 3, message: 'No name' },
      { line: 4, message: 'Price "abc" isn\'t whole cents' },
    ]);
  });

  it('reads the portal CSV export: scrambled barcodes become the NRS key, no barcode', () => {
    const csv = [
      'Upc,Department,qty,cents,incltaxes,inclfees,Name,size,ebt,byweight,"Fee Multiplier",cost_qty,cost_cents,variable_price,unit_upc,unit_count,is_oneclick',
      '"=""7ae5b1c0|45394""","General food",1,779,n,y,"FAFDA ",,y,n,1,1,0,n,,,y',
    ].join('\r\n');
    expect(detectNrsFormat(csv)).toBe('nrs-csv');
    const p = parseNrsPricebook(csv);
    expect(p).toMatchObject({ format: 'nrs-csv', quick_keys: 1, barcodes: { global: 0, store: 0, none: 1 } });
    expect(p.rows[0]).toMatchObject({ name: 'FAFDA', upc: null, cash_price_cents: 779, nrs: { key: '7ae5b1c0|45394', ebt: true, price_includes_fees: true } });
  });

  it('refuses anything else with a reason', () => {
    expect(detectNrsFormat('name,price\nCoke,1.99')).toBeNull();
    expect(parseNrsPricebook('name,price\nCoke,1.99').errors[0]!.message).toMatch(/isn't an NRS price book/);
  });

  it('suggests tax and age from department names', () => {
    expect(suggestDepartment('Grocery Non-Taxable')).toEqual({ taxable: false, min_age: null, restriction: null });
    expect(suggestDepartment('Beer single cans')).toEqual({ taxable: true, min_age: 21, restriction: 'alcohol' });
    expect(suggestDepartment('Vape')).toEqual({ taxable: true, min_age: 21, restriction: 'vape' });
    expect(suggestDepartment('Premium cigar')).toMatchObject({ restriction: 'tobacco' });
  });

  it('the report names items, categories, quick keys and what did not map', () => {
    const p = parseNrsPricebook(JSON.stringify([item({ includes_taxes: true })]));
    const r = nrsImportReport({
      parse: { ...p, departments: p.departments.map((d) => ({ ...d, exists: false })), error_count: 0 },
      result: { dry_run: false, created: 1, updated: 0, unchanged: 0, categories_created: ['Drinks'], sample: [] },
    });
    expect(r.headline).toBe('Imported 1 of 1 items: 1 new, 0 updated, 0 unchanged.');
    expect(r.lines.join(' ')).toMatch(/1 NRS departments, 1 new.*Quick keys: 0/);
    // Tax-inclusive prices carry over as tax-inclusive items (ADR 0044): reported as mapped, not as a problem.
    expect(r.unmapped.some((l) => /includes tax/i.test(l))).toBe(false);
    expect(r.lines).toContain('Tax-inclusive prices: 1 items ring at their marked price, tax inside.');
    expect(p.rows[0]!.tax_included).toBe(true);
  });
});
