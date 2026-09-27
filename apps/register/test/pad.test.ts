/**
 * The register pad (layout A, ADR 0045): digits fill from the cents column, like a till.
 */
import { describe, expect, it } from 'vitest';
import { padCents, pressPad } from '../src/core/pad';

const type = (keys: string[]) => keys.reduce((d, k) => pressPad(d, k), '');

describe('register pad', () => {
  it('fills from the cents column: 2-0-0-0 is $20.00, 00 is two zeros', () => {
    expect(padCents(type(['2', '0', '0', '0']))).toBe(2_000);
    expect(padCents(type(['1', '00', '0']))).toBe(1_000);
    expect(padCents(type(['5']))).toBe(5);
  });
  it('⌫ takes the last digit off, C clears, leading zeros never count', () => {
    expect(type(['1', '2', '3', '⌫'])).toBe('12');
    expect(type(['1', '2', 'C'])).toBe('');
    expect(type(['0', '00', '7'])).toBe('7');
  });
  it('stops at seven digits ($99,999.99)', () => {
    expect(padCents(type(['9', '9', '9', '9', '9', '9', '9', '9']))).toBe(9_999_999);
  });
});
