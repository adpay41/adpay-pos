/**
 * Money is integer cents, everywhere (ADR 0004).
 *
 * `Cents` is a branded number: the only ways to get one are `cents()` (which rejects anything that
 * is not a safe integer) and the helpers below. Application code never does raw arithmetic on an
 * amount — it calls these.
 *
 * Rates (tax, dual-price percentage) are integer **parts per million** so that 6.625% (NJ) is
 * exactly `66_250` and 8.875% (NYC) is exactly `88_750`. No rate is ever a float either.
 *
 * Rounding happens once, where a derived amount is computed, with the mode written at the call
 * site. The only mode v1 needs is half-up (ties away from zero), which is how US sales tax and
 * posted card prices are rounded.
 */

declare const centsBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: 'cents' };

/** Integer parts-per-million: 1% = 10_000 ppm, 100% = 1_000_000 ppm. */
export type RatePpm = number;

export const PPM_PER_UNIT = 1_000_000;
export const CURRENCY = 'USD' as const;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Assert and brand. Throws on floats, NaN, Infinity and anything past 2^53. */
export function cents(value: number): Cents {
  if (!isCents(value)) throw new MoneyError(`not an integer number of cents: ${String(value)}`);
  return value;
}

export const ZERO = cents(0);

function checked(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`cents overflowed the safe integer range: ${value}`);
  return value as Cents;
}

export function add(...amounts: Cents[]): Cents {
  let total = 0;
  for (const a of amounts) total += cents(a);
  return checked(total);
}

export function sub(a: Cents, b: Cents): Cents {
  return checked(cents(a) - cents(b));
}

export function neg(a: Cents): Cents {
  return checked(-cents(a));
}

export function sum(amounts: Iterable<Cents>): Cents {
  let total = 0;
  for (const a of amounts) total += cents(a);
  return checked(total);
}

/** Unit price × integer quantity. Quantities are whole units in v1 (no weighed items). */
export function mulQty(unit: Cents, qty: number): Cents {
  if (!Number.isSafeInteger(qty)) throw new MoneyError(`quantity must be an integer: ${qty}`);
  return checked(cents(unit) * qty);
}

export function assertRatePpm(rate: number): RatePpm {
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > PPM_PER_UNIT) {
    throw new MoneyError(`rate must be an integer between 0 and 1_000_000 ppm: ${rate}`);
  }
  return rate;
}

/**
 * amount × rate, rounded half-up (ties away from zero) to a whole cent. Uses BigInt so the
 * intermediate product can never lose precision.
 */
export function applyRateHalfUp(amount: Cents, rate: RatePpm): Cents {
  const a = BigInt(cents(amount));
  const r = BigInt(assertRatePpm(rate));
  const unit = BigInt(PPM_PER_UNIT);
  const product = a * r;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + unit / 2n) / unit;
  return checked(Number(negative ? -rounded : rounded));
}

/** Parse a user-typed dollar string ("13.49", "$1,299.5", "-2") into cents without floats. */
export function parseUsdToCents(input: string): Cents {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`not a dollar amount: ${JSON.stringify(input)}`);
  const [, sign, whole = '0', frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return checked(sign ? -value : value);
}

/** Display-only. Never feed the result back into the domain. */
export function formatUsd(amount: Cents): string {
  const c = cents(amount);
  const negative = c < 0;
  const abs = Math.abs(c);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-US');
  const rest = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${rest}`;
}
