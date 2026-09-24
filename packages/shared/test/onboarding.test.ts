import { describe, expect, it } from 'vitest';
import { OnboardingInput, PricingPlanInput, planOn, type PricingPlan } from '../src';

const plan = (from: string, rate = 40_000): PricingPlan => PricingPlanInput.parse({ kind: 'dual_pricing', dual_price_rate_ppm: rate, monthly_cents: 4_900, effective_from: from });

describe('pricing plans', () => {
  it('the plan in force is the latest that has started; same-day ties go to the newest row', () => {
    const rows = [
      { id: 'a', plan: plan('2026-01-01'), created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', plan: plan('2026-09-01'), created_at: '2026-08-20T00:00:00Z' },
      { id: 'c', plan: plan('2026-09-01', 35_000), created_at: '2026-08-25T00:00:00Z' },
      { id: 'd', plan: plan('2099-01-01'), created_at: '2026-09-01T00:00:00Z' },
    ];
    expect(planOn(rows, '2026-08-31')!.id).toBe('a');
    expect(planOn(rows, '2026-09-24')!.id).toBe('c');
    expect(planOn(rows, '2025-12-31')).toBeNull();
  });

  it('validates each model: no card markup over 10%, rates and money as integers', () => {
    expect(PricingPlanInput.safeParse({ kind: 'dual_pricing', dual_price_rate_ppm: 150_000, monthly_cents: 0, effective_from: '2026-01-01' }).success).toBe(false);
    expect(PricingPlanInput.safeParse({ kind: 'flat', rate_ppm: 29_000, per_txn_cents: 10, monthly_cents: 0, effective_from: '2026-01-01' }).success).toBe(true);
    expect(PricingPlanInput.safeParse({ kind: 'flat', rate_ppm: 2.9, per_txn_cents: 10, monthly_cents: 0, effective_from: '2026-01-01' }).success).toBe(false);
  });
});

describe('onboarding input', () => {
  it('normalizes the state and defaults one register and the cstore pack', () => {
    const v = OnboardingInput.parse({
      org: { name: 'Delta' },
      merchant: { name: 'Delta Deli' },
      owner: { name: 'Dana', phone: '917-555-0123' },
      location: { name: 'Main', state: 'nj', tax_rate_ppm: 66_250 },
      pricing: { kind: 'dual_pricing', dual_price_rate_ppm: 40_000, monthly_cents: 4_900, effective_from: '2026-09-24' },
    });
    expect(v.location.state).toBe('NJ');
    expect(v.registers).toBe(1);
    expect(v.merchant.enabled_packs).toEqual(['cstore']);
  });
});
