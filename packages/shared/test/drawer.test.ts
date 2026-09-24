import { describe, expect, it } from 'vitest';
import { foldDrawer, overShortByCashier, parseRegisterEvent, type RegisterEvent } from '../src';

const T = {
  org_id: '10000000-0000-4000-8000-000000000001',
  merchant_id: '20000000-0000-4000-8000-000000000001',
  location_id: '30000000-0000-4000-8000-000000000001',
  register_id: '40000000-0000-4000-8000-000000000001',
};
const MARIA = '50000000-0000-4000-8000-000000000001';
const DEV = '50000000-0000-4000-8000-000000000002';
let seq = 0;
const id = () => `60000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function ev(type: string, payload: unknown, opts: { sale?: string | null; actor?: string | null } = {}): RegisterEvent {
  return parseRegisterEvent({
    event_id: id(), schema_version: 1, sale_id: opts.sale ?? null, device_seq: seq, occurred_at: `2026-09-24T12:${String(seq % 60).padStart(2, '0')}:00Z`,
    ...T, trace_id: 't', actor_user_id: opts.actor ?? MARIA, type, payload,
  });
}
const cashSale = (amount: number) => {
  const sale = id();
  return ev('sale.tender_added', { tender_id: id(), tender_type: 'cash', amount_cents: amount, tendered_cents: amount, change_cents: 0, card: null }, { sale });
};

describe('drawer sessions', () => {
  it('expected = float + cash sales − refunds + paid-ins − paid-outs − drops; the blind count fixes over/short', () => {
    const s = id();
    const events = [
      ev('drawer.session_opened', { session_id: s, float_cents: 20_000 }),
      cashSale(1_491),
      cashSale(2_750),
      ev('sale.tender_added', { tender_id: id(), tender_type: 'card', amount_cents: 999, tendered_cents: null, change_cents: null, card: null }, { sale: id() }),
      ev('drawer.cash_movement', { movement_id: id(), session_id: s, kind: 'paid_out', amount_cents: 4_500, reason: 'Bread delivery', payee: 'Stella Bakery' }),
      ev('drawer.cash_movement', { movement_id: id(), session_id: s, kind: 'paid_in', amount_cents: 2_000, reason: 'Change from bank', payee: null }),
      ev('drawer.cash_movement', { movement_id: id(), session_id: s, kind: 'drop', amount_cents: 10_000, reason: 'Safe drop', payee: null }),
      ev('drawer.opened', { reason: 'manual', by_user_id: MARIA }),
      ev('drawer.session_closed', { session_id: s, counted_cents: 11_641, blind: true }),
    ];
    const { sessions } = foldDrawer(events);
    expect(sessions).toHaveLength(1);
    const d = sessions[0]!;
    // 20000 + 1491 + 2750 + 2000 − 4500 − 10000 = 11741
    expect(d).toMatchObject({ cash_sales_cents: 4_241, cash_sale_count: 2, paid_in_cents: 2_000, paid_out_cents: 4_500, drops_cents: 10_000, no_sale_opens: 1 });
    expect(d.expected_cents).toBe(11_741);
    expect(d.counted_cents).toBe(11_641);
    expect(d.over_short_cents).toBe(-100); // $1.00 short
    expect(d.closed_by).toBe(MARIA);
    expect(d.movements.map((m) => m.kind)).toEqual(['paid_out', 'paid_in', 'drop']);
  });

  it('an open session shows its running expected; cash before any session is reported, not lost', () => {
    const s = id();
    const { sessions, unassigned_cash_cents } = foldDrawer([cashSale(500), ev('drawer.session_opened', { session_id: s, float_cents: 10_000 }), cashSale(300)]);
    expect(unassigned_cash_cents).toBe(500);
    expect(sessions[0]).toMatchObject({ expected_cents: 10_300, closed_at: null, over_short_cents: null });
  });

  it('a session never closed ends where the next one begins', () => {
    const a = id();
    const b = id();
    const { sessions } = foldDrawer([ev('drawer.session_opened', { session_id: a, float_cents: 100 }), ev('drawer.session_opened', { session_id: b, float_cents: 200 })]);
    expect(sessions.map((s) => [s.session_id, s.closed_at])).toEqual([
      [a, null],
      [b, null],
    ]);
  });

  it('over/short adds up per cashier who closed', () => {
    const s1 = id();
    const s2 = id();
    const { sessions } = foldDrawer([
      ev('drawer.session_opened', { session_id: s1, float_cents: 10_000 }),
      ev('drawer.session_closed', { session_id: s1, counted_cents: 9_800, blind: true }),
      ev('drawer.session_opened', { session_id: s2, float_cents: 10_000 }, { actor: DEV }),
      ev('drawer.session_closed', { session_id: s2, counted_cents: 10_050, blind: true }, { actor: DEV }),
    ]);
    expect(overShortByCashier(sessions)).toEqual([
      { user_id: MARIA, sessions: 1, over_short_cents: -200 },
      { user_id: DEV, sessions: 1, over_short_cents: 50 },
    ]);
  });

  it('movements must be positive integer cents with a reason', () => {
    const base = { movement_id: id(), session_id: id(), kind: 'paid_out', reason: 'x', payee: null };
    expect(() => ev('drawer.cash_movement', { ...base, amount_cents: 0 })).toThrow();
    expect(() => ev('drawer.cash_movement', { ...base, amount_cents: 12.5 })).toThrow();
    expect(() => ev('drawer.cash_movement', { ...base, amount_cents: 100, reason: '' })).toThrow();
  });
});
