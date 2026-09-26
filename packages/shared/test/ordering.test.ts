import { describe, expect, it } from 'vitest';
import { nextDeliveries, orderText, suggestReorder, VendorInput } from '../src';

describe('deliveries', () => {
  it('the next delivery days after today', () => {
    // 2026-09-26 is a Saturday. Mondays and Thursdays.
    expect(nextDeliveries('2026-09-26', [1, 4], 3)).toEqual(['2026-09-28', '2026-10-01', '2026-10-05']);
    expect(nextDeliveries('2026-09-26', [], 2)).toEqual([]);
  });
});

describe('reorder suggestion', () => {
  // 28 days ending Friday 2026-09-25: 2 a day on weekdays, 10 on Saturdays and Sundays.
  const daily = Array.from({ length: 28 }, (_, i) => {
    const day = new Date(Date.parse('2026-09-25T12:00:00Z') - (27 - i) * 86_400_000).getUTCDay();
    return day === 0 || day === 6 ? 10 : 2;
  });

  it('covers until the delivery after next, with the weekend spike, plus the low point, rounded to the case', () => {
    // Today Saturday; deliveries Monday and Thursday → cover Sat, Sun, Mon, Tue, Wed = 10+10+2+2+2 = 26.
    const r = suggestReorder({ item_id: 'x', on_hand: 8, on_order: 0, reorder_point: 6, daily_units: daily, case_qty: 12 }, '2026-09-26', [1, 4]);
    expect(r).toEqual({ qty: 24, forecast: 26, until: '2026-10-01' }); // 26 + 6 − 8 = 24 → two cases
  });

  it('nothing when the shelf and what is on order already cover it', () => {
    expect(suggestReorder({ item_id: 'x', on_hand: 20, on_order: 24, reorder_point: 6, daily_units: daily, case_qty: 12 }, '2026-09-26', [1, 4]).qty).toBe(0);
  });

  it('a vendor without delivery days is covered for a week', () => {
    expect(suggestReorder({ item_id: 'x', on_hand: 0, on_order: 0, reorder_point: null, daily_units: daily, case_qty: 1 }, '2026-09-26', [])).toMatchObject({ until: '2026-10-03', forecast: 30 });
  });
});

describe('vendors and the order message', () => {
  it('needs where to send orders', () => {
    expect(VendorInput.safeParse({ name: 'Coca-Cola', order_via: 'sms' }).success).toBe(false);
    expect(VendorInput.safeParse({ name: 'Coca-Cola', phone: '(201) 555-0170', delivery_days: [1, 4] }).success).toBe(true);
  });

  it('reads like a text to the rep', () => {
    expect(orderText('Journal Square Deli', 'Coca-Cola', [{ name: 'Coke 20oz', qty: 24 }], null)).toBe('Order from Journal Square Deli for Coca-Cola:\n24 × Coke 20oz\nThank you!');
  });
});
