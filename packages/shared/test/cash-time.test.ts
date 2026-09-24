import { describe, expect, it } from 'vitest';
import { denominationTotal, dropSuggestion, foldDrawer, foldShifts, hhmm, parseRegisterEvent, timesheetCsv, type RegisterEvent } from '../src';

const T = {
  org_id: '10000000-0000-4000-8000-000000000001',
  merchant_id: '20000000-0000-4000-8000-000000000001',
  location_id: '30000000-0000-4000-8000-000000000001',
  register_id: '40000000-0000-4000-8000-000000000001',
};
const SESSION = '50000000-0000-4000-8000-000000000001';
const MARIA = '60000000-0000-4000-8000-000000000001';
let seq = 0;
const ev = (type: string, payload: unknown, at = '2026-09-24T12:00:00Z'): RegisterEvent =>
  parseRegisterEvent({
    event_id: `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, schema_version: 1, sale_id: null, device_seq: seq,
    occurred_at: at, ...T, trace_id: 't', actor_user_id: MARIA, type, payload,
  });

describe('denominations and drops', () => {
  it('adds a count by denomination in integer cents', () => {
    expect(denominationTotal({ '2000': 12, '500': 3, '100': 7, '25': 9, '1': 4 })).toBe(24_000 + 1_500 + 700 + 225 + 4);
    expect(denominationTotal({ '999': 5 })).toBe(0); // not a US denomination
  });
  it('asks for a drop over the threshold, in whole $20s back toward the float', () => {
    expect(dropSuggestion(55_000, 20_000, 60_000)).toEqual({ needed: false, suggest_cents: 0 });
    expect(dropSuggestion(71_300, 20_000, 60_000)).toEqual({ needed: true, suggest_cents: 50_000 });
    expect(dropSuggestion(71_300, 20_000, 0).needed).toBe(false);
  });
});

describe('drawer fold (P15 additions)', () => {
  it('keeps counterfeits, the denomination count, the photo and the handover on the session', () => {
    seq = 0;
    const { sessions } = foldDrawer([
      ev('drawer.session_opened', { session_id: SESSION, float_cents: 10_000 }),
      ev('drawer.counterfeit', { session_id: SESSION, denomination_cents: 2_000, note: 'no strip' }),
      ev('drawer.session_closed', { session_id: SESSION, counted_cents: 10_000, blind: true, denominations: { '2000': 5 }, photo_media_id: '70000000-0000-4000-8000-000000000001', handover: true }),
    ]);
    expect(sessions[0]).toMatchObject({
      over_short_cents: 0,
      denominations: { '2000': 5 },
      photo_media_id: '70000000-0000-4000-8000-000000000001',
      handover: true,
      counterfeits: [{ denomination_cents: 2_000, note: 'no strip', by_user_id: MARIA }],
    });
  });
  it('older close events without the new fields still fold', () => {
    seq = 0;
    const { sessions } = foldDrawer([ev('drawer.session_opened', { session_id: SESSION, float_cents: 0 }), ev('drawer.session_closed', { session_id: SESSION, counted_cents: 0, blind: true })]);
    expect(sessions[0]).toMatchObject({ denominations: null, photo_media_id: null, handover: false, counterfeits: [] });
  });
});

describe('time clock', () => {
  it('pairs punches into shifts; a double punch-in keeps the first; an open shift runs to now', () => {
    seq = 0;
    const shifts = foldShifts(
      [
        ev('staff.clocked_in', { user_id: MARIA }, '2026-09-22T12:00:00Z'),
        ev('staff.clocked_in', { user_id: MARIA }, '2026-09-22T12:30:00Z'),
        ev('staff.clocked_out', { user_id: MARIA, reason: 'manual' }, '2026-09-22T20:15:00Z'),
        ev('staff.clocked_out', { user_id: MARIA, reason: 'manual' }, '2026-09-22T21:00:00Z'), // no open shift: ignored
        ev('staff.clocked_in', { user_id: MARIA }, '2026-09-23T13:00:00Z'),
      ],
      new Date('2026-09-23T15:30:00Z'),
    );
    expect(shifts.map((s) => [s.in_at.slice(0, 16), s.out_at?.slice(0, 16) ?? null, s.minutes])).toEqual([
      ['2026-09-22T12:00', '2026-09-22T20:15', 495],
      ['2026-09-23T13:00', null, 150],
    ]);
    expect(hhmm(495)).toBe('8:15');
  });
  it('exports a payroll CSV with a column per day', () => {
    const csv = timesheetCsv({
      from: '2026-09-21',
      to: '2026-09-23',
      rows: [{ user_id: MARIA, name: 'Santos, Maria', by_day: { '2026-09-22': 495 }, total_minutes: 495, overtime_minutes: 0, open_shift: false }],
      shifts: [],
    });
    expect(csv).toBe('Employee,2026-09-21,2026-09-22,2026-09-23,Total hours,Overtime hours\n"Santos, Maria",0:00,8:15,0:00,8:15,0:00\n');
  });
});
