import { describe, expect, it } from 'vitest';
import { agentLine, agentStatementsCsv, inForce, type ResidualRow } from '../src';

const row = (over: Partial<ResidualRow> = {}): ResidualRow => ({
  merchant_id: 'm1',
  merchant_name: 'Deli, "The"',
  month: '2026-09',
  plan_kind: 'flat',
  card_volume_cents: 1_000_00,
  card_transactions: 10,
  cash_volume_cents: 0,
  registers: 1,
  cost_entered: true,
  processing_revenue_cents: 2_500,
  subscription_revenue_cents: 4_999,
  revenue_cents: 7_499,
  cost_cents: 1_000,
  margin_cents: 6_499,
  effective_rate_ppm: 25_000,
  ...over,
});

describe('agent split', () => {
  it('share of margin or revenue, rounded down; no clawback; margin waits for cost', () => {
    const t = { effective_from: '2026-09-01', basis: 'margin' as const, split_ppm: 333_333, bounty_cents: 5_000 };
    expect(agentLine(row(), t, false)).toMatchObject({ residual_cents: 2_166, bounty_cents: 0 });
    expect(agentLine(row(), t, true).bounty_cents).toBe(5_000);
    expect(agentLine(row({ margin_cents: -500 }), t, false).residual_cents).toBe(0);
    expect(agentLine(row({ margin_cents: null, cost_entered: false }), t, false).residual_cents).toBeNull();
    expect(agentLine(row({ margin_cents: null }), { ...t, basis: 'revenue' }, false).residual_cents).toBe(2_499);
  });

  it('the dated row in force: latest start on or before the date, then latest written', () => {
    const rows = [
      { effective_from: '2026-08-01', created_at: '2026-08-01T00:00:00Z', v: 1 },
      { effective_from: '2026-09-01', created_at: '2026-09-02T00:00:00Z', v: 2 },
      { effective_from: '2026-09-01', created_at: '2026-09-03T00:00:00Z', v: 3 },
      { effective_from: '2026-10-01', created_at: '2026-09-04T00:00:00Z', v: 4 },
    ];
    expect(inForce(rows, '2026-09-30')?.v).toBe(3);
    expect(inForce(rows, '2026-08-15')?.v).toBe(1);
    expect(inForce(rows, '2026-07-31')).toBeNull();
  });

  it('CSV quotes names and writes cents as dollars', () => {
    const line = agentLine(row(), { effective_from: '2026-09-01', basis: 'revenue', split_ppm: 200_000, bounty_cents: 0 }, false);
    const csv = agentStatementsCsv([{ agent_id: 'a', agent_name: 'Ravi', kind: 'agent', month: '2026-09', lines: [line], residual_cents: 1_499, bounty_cents: 0, total_cents: 1_499, pending: 0 }]);
    expect(csv).toContain('2026-09,Ravi,"Deli, ""The""",revenue,20.0000,1000.00,74.99,64.99,14.99,0.00');
    expect(csv.trim().split('\n').at(-1)).toBe('2026-09,Ravi,TOTAL,,,,,,14.99,0.00');
  });
});
