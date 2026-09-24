import { describe, expect, it } from 'vitest';
import { AlertSettingsInput, pctChangeTenths, pctChangeText } from '../src';

describe('percent change, integer tenths', () => {
  it('rounds half away from zero and never divides by zero', () => {
    expect(pctChangeTenths(1_125, 1_000)).toBe(125);
    expect(pctChangeTenths(1_000, 1_125)).toBe(-111); // −11.11%
    expect(pctChangeTenths(1_000_5, 1_000_0)).toBe(1); // +0.05% → 0.1
    expect(pctChangeTenths(500, 0)).toBeNull();
    expect(pctChangeTenths(0, 800)).toBe(-1_000);
  });
  it('reads as words', () => {
    expect(pctChangeText(125)).toBe('up 12.5%');
    expect(pctChangeText(-30)).toBe('down 3%');
    expect(pctChangeText(0)).toBe('level');
    expect(pctChangeText(null)).toBeNull();
  });
});

describe('alert settings', () => {
  it('defaults, and only merchant-facing rules can be muted', () => {
    expect(AlertSettingsInput.parse({})).toEqual({ muted: [], large_refund_cents: 2_500, drawer_short_cents: 500, no_sale_spike: 5 });
    expect(AlertSettingsInput.safeParse({ muted: ['register_offline'] }).success).toBe(true);
    expect(AlertSettingsInput.safeParse({ muted: ['events_rejected'] }).success).toBe(false);
  });
});
