import { describe, expect, it } from 'vitest';
import { cardAmountFor, cents, coverForCard, splitTaxGroups, splitTotals } from '../src';

const T = (total: number, tax = 0) => ({ subtotal_cents: total - tax, tax_cents: tax, total_cents: total }) as never;

describe('split tender: each portion at its own price', () => {
  it('cash first, card for the rest: the card pays the card price of what is left, not of the whole', () => {
    // $26.77 cash price / $27.29 card price; customer hands over $10 cash.
    const C = 2_677;
    const K = 2_729;
    const left = C - 1_000;
    const due = cardAmountFor(left, C, K);
    expect(due).toBe(1_710); // 1677 × 2729 / 2677 = 1709.58 → 1710
    expect(coverForCard(due, left, C, K)).toBe(left); // finishing on card closes it exactly
    expect(1_000 + due).toBeLessThan(K); // cheaper than paying all by card
    expect(1_000 + due).toBeGreaterThan(C); // dearer than paying all in cash
  });

  it('paying the whole card price covers everything; a partial card covers its share', () => {
    expect(cardAmountFor(2_000, 2_000, 2_080)).toBe(2_080);
    expect(coverForCard(1_040, 2_000, 2_000, 2_080)).toBe(1_000); // half the card total = half the sale
    expect(coverForCard(10_000, 500, 2_000, 2_080)).toBe(500); // never covers more than is left
  });

  it('two cards: the second card finishes the sale exactly, whatever the first one covered', () => {
    const C = 1_999;
    const K = 2_079;
    const first = coverForCard(1_000, C, C, K);
    const due = cardAmountFor(C - first, C, K);
    expect(coverForCard(due, C - first, C, K)).toBe(C - first);
    expect(1_000 + due).toBeGreaterThanOrEqual(K - 1);
    expect(1_000 + due).toBeLessThanOrEqual(K + 1);
  });

  it('declared totals: the money taken, with tax split by what each tender covered', () => {
    // cash tax 100 of 2000, card tax 104 of 2080; half paid each way.
    const t = splitTotals(T(2_000, 100), T(2_080, 104), [
      { tender_type: 'cash', amount_cents: 1_000, covers_cash_cents: 1_000 },
      { tender_type: 'card', amount_cents: 1_040, covers_cash_cents: 1_000 },
    ]);
    expect(t).toEqual({ subtotal_cents: 1_938, tax_cents: 102, total_cents: 2_040 });
  });

  it('everything is integers (property sweep)', () => {
    for (let C = 1; C < 3_000; C += 37) {
      const K = C + Math.floor(C / 25);
      for (let cash = 0; cash < C; cash += 101) {
        const due = cardAmountFor(C - cash, C, K);
        expect(Number.isInteger(due)).toBe(true);
        expect(coverForCard(due, C - cash, C, K)).toBe(C - cash);
      }
    }
  });
});

describe('splitTaxGroups', () => {
  it('blends each rate and lands exactly on the declared tax', () => {
    // The browser case: $6.71 cash / $6.97 card, $3.00 cash + $3.85 card, declared tax 43.
    const cash = [{ rate_ppm: 66250, taxable_cents: cents(629), tax_cents: cents(42) }];
    const card = [{ rate_ppm: 66250, taxable_cents: cents(654), tax_cents: cents(43) }];
    const portions = [
      { tender_type: 'cash' as const, amount_cents: 300, covers_cash_cents: 300 },
      { tender_type: 'card' as const, amount_cents: 385, covers_cash_cents: 371 },
    ];
    const declared = splitTotals(
      { subtotal_cents: cents(629), tax_cents: cents(42), total_cents: cents(671) },
      { subtotal_cents: cents(654), tax_cents: cents(43), total_cents: cents(697) },
      portions,
    );
    const g = splitTaxGroups(cash, card, portions, 671, declared.tax_cents);
    expect(g.reduce((n, x) => n + x.tax_cents, 0)).toBe(declared.tax_cents);
    expect(declared.subtotal_cents + declared.tax_cents).toBe(685);
  });
});
