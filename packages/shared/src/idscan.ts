/**
 * ID scan (build plan P16b, Bible 1.4): the PDF417 barcode on the back of a US/Canadian driver's
 * licence, read by the same 2D scanner, parsed per the AAMVA DL/ID card design standard. ADR 0026.
 *
 * **What leaves this function is derived facts only**: age on the day, whether it is expired, the
 * issuing jurisdiction, and flags. The licence number, name, address and date of birth are read to
 * compute those and are never returned, so they can't be logged, synced or stored (Bible: "logs the
 * check, not the ID number").
 */

export type IdFlag =
  /** Not an AAMVA barcode, or the fields we need are missing. */
  | 'unreadable'
  | 'expired'
  | 'under_age'
  /** Date of birth in the future, expiry before issue, or an impossible age: a common fake tell. */
  | 'implausible_dates';

export interface IdCheck {
  ok: boolean;
  age: number | null;
  /** YYYY-MM-DD, or null when unreadable. */
  expires: string | null;
  /** Two-letter jurisdiction (NJ, NY…). */
  jurisdiction: string | null;
  flags: IdFlag[];
}

function date8(v: string | undefined, canadian: boolean): string | null {
  if (!v || !/^\d{8}$/.test(v)) return null;
  // US: MMDDCCYY; Canada (and some older cards): CCYYMMDD.
  const ccyyFirst = canadian || Number(v.slice(0, 4)) > 1231;
  const [y, m, d] = ccyyFirst ? [v.slice(0, 4), v.slice(4, 6), v.slice(6, 8)] : [v.slice(4, 8), v.slice(0, 2), v.slice(2, 4)];
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${m}-${d}`;
}

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD day. */
export function ageOn(dob: string, day: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * Parse what the scanner typed and check it against the required age on `today` (store-local
 * YYYY-MM-DD). Tolerant of how wedge scanners deliver it: CR, LF or CRLF between elements, the
 * record separator sometimes dropped.
 */
export function checkId(raw: string, minAge: number, today: string): IdCheck {
  const bad: IdCheck = { ok: false, age: null, expires: null, jurisdiction: null, flags: ['unreadable'] };
  const text = raw.replace(/\r\n?/g, '\n');
  const header = /ANSI ?(\d{6})(\d{2})/.exec(text);
  if (!header) return bad;
  const fields = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // The first element of the subfile sits on the header line, after the subfile type ("…DLDAQ…").
    // The greedy .* takes the last "DL"/"ID" followed by three capitals, never a designator's digits.
    const m = line.includes('ANSI') ? /.*(?:DL|ID)([A-Z]{3})(.*)$/.exec(line) : /^(?:DL|ID)?([A-Z]{3})(.*)$/.exec(line);
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!.trim());
  }
  const jurisdiction = (fields.get('DAJ') ?? '').toUpperCase().slice(0, 2) || null;
  const canadian = fields.get('DCG') === 'CAN';
  const dob = date8(fields.get('DBB'), canadian);
  const expires = date8(fields.get('DBA'), canadian);
  const issued = date8(fields.get('DBD'), canadian);
  if (!dob || !expires) return { ...bad, jurisdiction };

  const flags: IdFlag[] = [];
  const age = ageOn(dob, today);
  if (expires < today) flags.push('expired');
  if (age < minAge) flags.push('under_age');
  if (dob > today || age > 120 || (issued !== null && issued > expires)) flags.push('implausible_dates');
  // A header-vs-DAJ jurisdiction check needs the verified AAMVA issuer table; not guessed here (ADR 0026).
  return { ok: flags.length === 0, age, expires, jurisdiction, flags };
}

export const ID_FLAG_TEXT: Record<IdFlag, string> = {
  unreadable: 'Couldn’t read that ID. Check it by eye.',
  expired: 'This ID is expired.',
  under_age: 'Under age for this item.',
  implausible_dates: 'The dates on this ID don’t add up: check it carefully.',
};
