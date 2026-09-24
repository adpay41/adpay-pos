import { describe, expect, it } from 'vitest';
import { lotteryCsv, reconcileDay, ticketsSold } from '../src';

describe('lottery math', () => {
  it('tickets sold from bin readings; a sold-out pack counts to its end', () => {
    expect(ticketsSold(12, { next_ticket: 20, sold_out: false }, 60)).toBe(8);
    expect(ticketsSold(20, { next_ticket: 0, sold_out: true }, 60)).toBe(40);
    expect(ticketsSold(20, { next_ticket: 15, sold_out: false }, 60)).toBe(0); // a lower reading never sells negative tickets
  });
  it('reconciles rung sales and payouts against the terminal', () => {
    const d = reconcileDay({ business_date: '2026-09-23', instant: [{ game_number: '1654', game_name: 'Lucky 7s', tickets: 8, amount_cents: 4_000 }], rung_cents: 5_200, drawer_payouts_cents: 2_500, terminal: { online_sales_cents: 1_000, cashes_cents: 2_500, instant_sales_cents: null }, counted: true });
    expect(d).toMatchObject({ instant_cents: 4_000, sales_difference_cents: 200, payout_difference_cents: 0 });
    expect(reconcileDay({ ...d, terminal: null, counted: false }).sales_difference_cents).toBeNull();
  });
  it('CSV row per day', () => {
    const d = reconcileDay({ business_date: '2026-09-23', instant: [{ game_number: '1654', game_name: 'x', tickets: 8, amount_cents: 4_000 }], rung_cents: 5_000, drawer_payouts_cents: 3_000, terminal: { online_sales_cents: 1_000, cashes_cents: 2_500, instant_sales_cents: null }, counted: true });
    expect(lotteryCsv([d]).split('\n')[1]).toBe('2026-09-23,40.00,8,50.00,30.00,10.00,25.00,0.00,5.00');
  });
});
