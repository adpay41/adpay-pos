/**
 * The register pad (layout A, ADR 0045; @ and PLU, ADR 0047): digits fill from the cents column as an
 * amount, and the same digits are a count for @ and a code for PLU, leading zeros kept.
 */
import { describe, expect, it } from 'vitest';
import { padCents, padQty, pluCandidates, pressPad } from '../src/core/pad';

const type = (keys: string[]) => keys.reduce((d, k) => pressPad(d, k), '');

describe('register pad', () => {
  it('fills from the cents column: 2-0-0-0 is $20.00, 00 is two zeros', () => {
    expect(padCents(type(['2', '0', '0', '0']))).toBe(2_000);
    expect(padCents(type(['1', '00', '0']))).toBe(1_000);
    expect(padCents(type(['5']))).toBe(5);
  });
  it('⌫ takes the last digit off, C clears; leading zeros are kept as typed but never change the amount', () => {
    expect(type(['1', '2', '3', '⌫'])).toBe('12');
    expect(type(['1', '2', 'C'])).toBe('');
    expect(type(['0', '9', '0', '1', '4'])).toBe('09014');
    expect(padCents('0007')).toBe(7);
  });
  it('stops at seven digits ($99,999.99)', () => {
    expect(padCents(type(['9', '9', '9', '9', '9', '9', '9', '9']))).toBe(9_999_999);
  });
  it('@: the digits as a count, 1 to 999', () => {
    expect(padQty('3')).toBe(3);
    expect(padQty('012')).toBe(12);
    expect(padQty('')).toBeNull();
    expect(padQty('0')).toBeNull();
    expect(padQty('1000')).toBeNull();
  });
  it('PLU: as typed, then without leading zeros', () => {
    expect(pluCandidates('09014')).toEqual(['09014', '9014']);
    expect(pluCandidates('4011')).toEqual(['4011']);
    expect(pluCandidates('')).toEqual([]);
  });
});

describe('PLU key lookup', () => {
  const index = new Map<string, string>([
    ['plu:09014', 'egg sandwich'],
    ['plu:4011', 'banana'],
    ['12000161155', 'pepsi'],
  ]);
  const byBarcode = (code: string) => index.get(code.replace(/^0+/, '')) ?? null;
  it('finds by PLU as typed, without leading zeros, or with them', async () => {
    const { findByPlu } = await import('../src/core/pad');
    expect(findByPlu(index, '09014', byBarcode)).toBe('egg sandwich');
    expect(findByPlu(index, '9014', byBarcode)).toBe('egg sandwich');
    expect(findByPlu(index, '04011', byBarcode)).toBe('banana');
    expect(findByPlu(index, '012000161155', byBarcode)).toBe('pepsi'); // falls back to the barcode
    expect(findByPlu(index, '777', byBarcode)).toBeNull();
  });
});
