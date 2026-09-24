import { describe, expect, it } from 'vitest';
import {
  add,
  applyRateHalfUp,
  cents,
  computeTax,
  computeTotals,
  deriveCardPrice,
  formatUsd,
  MoneyError,
  mulQty,
  parseUsdToCents,
  resolveDualPrice,
} from '../src';

describe('cents', () => {
  it('accepts integers and rejects everything else', () => {
    expect(cents(1349)).toBe(1349);
    expect(() => cents(13.49)).toThrow(MoneyError);
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => cents(2 ** 53)).toThrow(MoneyError);
  });

  it('never produces a float through the helpers', () => {
    expect(add(cents(10), cents(20), cents(1))).toBe(31);
    expect(mulQty(cents(199), 3)).toBe(597);
    expect(() => mulQty(cents(199), 1.5)).toThrow(MoneyError);
  });
});

describe('applyRateHalfUp', () => {
  it('rounds ties away from zero', () => {
    // 6.625% of 200 = 13.25 -> 13 ; of 1000 = 66.25 -> 66 ; of 1132 = 74.995 -> 75
    expect(applyRateHalfUp(cents(200), 66_250)).toBe(13);
    expect(applyRateHalfUp(cents(1000), 66_250)).toBe(66);
    expect(applyRateHalfUp(cents(1132), 66_250)).toBe(75);
    // exact tie: 50% of 1 cent = 0.5 -> 1
    expect(applyRateHalfUp(cents(1), 500_000)).toBe(1);
    expect(applyRateHalfUp(cents(-1), 500_000)).toBe(-1);
  });

  it('rejects non-integer rates', () => {
    expect(() => applyRateHalfUp(cents(100), 6.625)).toThrow(MoneyError);
  });
});

describe('dual pricing', () => {
  it('derives the card price from the cash price at the location rate', () => {
    // 4% on $2.49 = 9.96c -> 10c
    expect(deriveCardPrice(cents(249), 40_000)).toBe(259);
    expect(resolveDualPrice({ cash_price_cents: 899, card_price_cents: null }, 40_000)).toEqual({ cash: 899, card: 935 });
  });

  it('honours an explicit card price override', () => {
    expect(resolveDualPrice({ cash_price_cents: 1400, card_price_cents: 1400 }, 40_000)).toEqual({
      cash: 1400,
      card: 1400,
    });
  });
});

describe('tax', () => {
  it('rounds once per rate group, not per line', () => {
    const line = { qty: 1, unit_price_cents: 10, discount_cents: 0, taxable: true, tax_rate_ppm: 66_250 };
    // per-line: 0.6625c -> 1c each = 3c ; grouped: 30c * 6.625% = 1.9875c -> 2c
    expect(computeTax([line, line, line])).toBe(2);
  });

  it('skips non-taxable lines (lottery, tobacco flag, grocery)', () => {
    const totals = computeTotals([
      { qty: 2, unit_price_cents: 899, discount_cents: 100, taxable: true, tax_rate_ppm: 66_250 },
      { qty: 1, unit_price_cents: 200, discount_cents: 0, taxable: false, tax_rate_ppm: 66_250 },
    ]);
    // taxable net 1698 * 6.625% = 112.49 -> 112
    expect(totals).toEqual({ subtotal_cents: 1898, tax_cents: 112, total_cents: 2010 });
  });
});

describe('parse / format at the edge', () => {
  it('parses dollar strings without floats', () => {
    expect(parseUsdToCents('13.49')).toBe(1349);
    expect(parseUsdToCents('$1,299.5')).toBe(129_950);
    expect(parseUsdToCents('0.07')).toBe(7);
    expect(parseUsdToCents('-2')).toBe(-200);
    expect(() => parseUsdToCents('1.999')).toThrow(MoneyError);
    expect(() => parseUsdToCents('abc')).toThrow(MoneyError);
  });

  it('formats for display', () => {
    expect(formatUsd(cents(1349))).toBe('$13.49');
    expect(formatUsd(cents(5))).toBe('$0.05');
    expect(formatUsd(cents(123_456_789))).toBe('$1,234,567.89');
    expect(formatUsd(cents(-250))).toBe('-$2.50');
  });
});
