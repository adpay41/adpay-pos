import { describe, expect, it } from 'vitest';
import { ageOn, checkId } from '../src';

/** A synthetic AAMVA payload (fake person) as a wedge scanner types it: elements separated by line breaks. */
const aamva = (el: Record<string, string>, sep = '\n') =>
  ['@', '\u001e\rANSI 636036090002DL00410278ZN03190008DL' + Object.entries(el).map(([k, v]) => `${k}${v}`).join(sep)].join('\n');
const PERSON = { DAQ: 'X12345678901234', DCS: 'SAMPLE', DAC: 'ALEX', DBB: '07151999', DBA: '07152029', DBD: '07152021', DAJ: 'NJ' };

describe('ID scan (AAMVA)', () => {
  it('reads age, expiry and state; returns no personal data', () => {
    const r = checkId(aamva(PERSON), 21, '2026-09-24');
    expect(r).toEqual({ ok: true, age: 27, expires: '2029-07-15', jurisdiction: 'NJ', flags: [] });
    expect(JSON.stringify(r)).not.toMatch(/X12345|SAMPLE|ALEX|1999/);
  });

  it('flags under age on the day, and turns 21 exactly on the birthday', () => {
    const teen = { ...PERSON, DBB: '09252005' };
    expect(checkId(aamva(teen), 21, '2026-09-24').flags).toEqual(['under_age']);
    expect(checkId(aamva(teen), 21, '2026-09-25').ok).toBe(true);
    expect(checkId(aamva(teen), 18, '2026-09-24').ok).toBe(true);
  });

  it('flags expired IDs and impossible dates', () => {
    expect(checkId(aamva({ ...PERSON, DBA: '01012026' }), 21, '2026-09-24').flags).toEqual(['expired']);
    expect(checkId(aamva({ ...PERSON, DBD: '01012030' }), 21, '2026-09-24').flags).toEqual(['implausible_dates']);
    expect(checkId(aamva({ ...PERSON, DBB: '01012030' }), 21, '2026-09-24').flags).toContain('implausible_dates');
  });

  it('accepts CRLF from the scanner and Canadian CCYYMMDD dates', () => {
    expect(checkId(aamva(PERSON, '\r\n'), 21, '2026-09-24').ok).toBe(true);
    expect(checkId(aamva({ ...PERSON, DBB: '19990715', DBA: '20290715', DCG: 'CAN' }), 21, '2026-09-24')).toMatchObject({ ok: true, age: 27 });
  });

  it('reads an element that sits on the header line, right after the subfile type', () => {
    const { DBB, ...rest } = PERSON;
    expect(checkId(aamva({ DBB, ...rest }), 21, '2026-09-24')).toMatchObject({ ok: true, age: 27 });
  });

  it('anything else is unreadable: check by eye', () => {
    expect(checkId('012345678905', 21, '2026-09-24')).toEqual({ ok: false, age: null, expires: null, jurisdiction: null, flags: ['unreadable'] });
    expect(checkId(aamva({ DAQ: 'X1' }), 21, '2026-09-24').flags).toEqual(['unreadable']);
  });

  it('age in whole years', () => {
    expect(ageOn('2000-02-29', '2021-02-28')).toBe(20);
    expect(ageOn('2000-02-29', '2021-03-01')).toBe(21);
  });
});
