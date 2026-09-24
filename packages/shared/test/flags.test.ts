import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_KEYS, resolveFlags } from '../src';

describe('feature flags', () => {
  it('defaults everything on; overrides win; junk falls back to defaults', () => {
    const all = resolveFlags({});
    expect(FEATURE_FLAG_KEYS.every((k) => all[k])).toBe(true);
    expect(resolveFlags({ card_payments: false }).card_payments).toBe(false);
    expect(resolveFlags({ card_payments: 'no' }).card_payments).toBe(true);
    expect(resolveFlags(null).hold_tickets).toBe(true);
  });
});
