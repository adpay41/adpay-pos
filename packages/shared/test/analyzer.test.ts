import { describe, expect, it } from 'vitest';
import { PricingPlanInput, StatementInput, analyzeStatement, ppmOf, ratePpm, residual } from '../src';

const dual = PricingPlanInput.parse({ kind: 'dual_pricing', dual_price_rate_ppm: 40_000, monthly_cents: 4_900, per_register_cents: 1_500, effective_from: '2026-01-01' });
const icp = PricingPlanInput.parse({ kind: 'ic_plus', markup_ppm: 3_000, per_txn_cents: 10, monthly_cents: 2_900, effective_from: '2026-01-01' });
const flat = PricingPlanInput.parse({ kind: 'flat', rate_ppm: 26_000, per_txn_cents: 10, monthly_cents: 0, effective_from: '2026-01-01' });

describe('integer rate helpers', () => {
  it('round half-up once', () => {
    expect(ppmOf(12_345, 29_000)).toBe(358); // 358.005 → 358
    expect(ppmOf(50, 10_000)).toBe(1); // 0.5 → 1
    expect(ratePpm(1_234, 45_678)).toBe(27_015);
    expect(ratePpm(5, 0)).toBeNull();
  });
});

describe('statement analyzer', () => {
  // A deli: $42,000 card volume, 2,800 transactions, $1,386 fees (3.3%), $1,008 of it interchange, $79 Clover.
  const s = StatementInput.parse({ prospect: 'Bodega on 5th', processor: 'Clover', month: '2026-08', card_volume_cents: 4_200_000, transactions: 2_800, total_fees_cents: 138_600, interchange_cents: 100_800, pos_fees_cents: 7_900, registers: 2, offers: [dual] });

  it('reads the statement: effective rate, markup, average ticket', () => {
    const a = analyzeStatement(s, []);
    expect(a.effective_rate_ppm).toBe(33_000);
    expect(a.markup_cents).toBe(37_800);
    expect(a.markup_rate_ppm).toBe(9_000);
    expect(a.today_total_cents).toBe(146_500);
    expect(a.average_ticket_cents).toBe(1_500);
  });

  it('quotes each plan against today', () => {
    const [d, i, f] = analyzeStatement(s, [dual, icp, flat]).quotes;
    // Dual: no processing cost, subscription $49 + one extra register $15.
    expect(d).toMatchObject({ merchant_cost_cents: 6_400, saving_cents: 140_100 });
    // IC+: 1008 interchange + 0.3% of 42k (126) + 2800 × 10¢ (280) + 29 = $1,443.00
    expect(i).toMatchObject({ merchant_cost_cents: 144_300, saving_cents: 2_200 });
    // Flat: 2.6% (1092) + 280 = $1,372.00
    expect(f).toMatchObject({ merchant_cost_cents: 137_200, saving_cents: 9_300 });
  });

  it('without interchange, IC+ is not compared', () => {
    const q = analyzeStatement({ ...s, interchange_cents: null }, [icp]).quotes[0]!;
    expect(q.saving_cents).toBe(0);
    expect(q.note).toMatch(/interchange/);
  });
});

describe('residuals', () => {
  it('dual pricing: the surcharge inside card volume is revenue; interchange and fees are cost', () => {
    // $10,400 of card volume at +4% contains $400 of surcharge.
    const r = residual({ card_volume_cents: 1_040_000, card_transactions: 700, registers: 2, plan: dual, cost: { interchange_cents: 22_000, processor_fees_cents: 3_000 } });
    expect(r).toMatchObject({ processing_revenue_cents: 40_000, subscription_revenue_cents: 6_400, revenue_cents: 46_400, cost_cents: 25_000, margin_cents: 21_400 });
  });
  it('IC+: interchange passes through, so only processor fees are cost', () => {
    const r = residual({ card_volume_cents: 1_000_000, card_transactions: 500, registers: 1, plan: icp, cost: { interchange_cents: 20_000, processor_fees_cents: 1_000 } });
    expect(r).toMatchObject({ processing_revenue_cents: 3_000 + 5_000, revenue_cents: 8_000 + 2_900, cost_cents: 1_000, margin_cents: 9_900 });
  });
  it('no cost entered: revenue only, margin unknown', () => {
    const r = residual({ card_volume_cents: 1_000_000, card_transactions: 500, registers: 1, plan: flat, cost: null });
    expect(r.revenue_cents).toBe(26_000 + 5_000);
    expect(r.margin_cents).toBeNull();
  });
});
