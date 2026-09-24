/**
 * Today vs yesterday vs the same day last week, by hour (build plan P11, Bible 2.1 L31). The owner's
 * question is "am I up or down?", and it must be fair: at 2:40pm, today so far is compared with
 * yesterday **up to 2:40pm**, not with all of yesterday.
 */

export type CompareDayKey = 'today' | 'yesterday' | 'last_week';

export interface CompareDay {
  key: CompareDayKey;
  /** Store-local date, YYYY-MM-DD. */
  date: string;
  total_cents: number;
  count: number;
  /** Sales completed before the current store-local time of day on that date. */
  so_far_cents: number;
  so_far_count: number;
  by_hour: { hour: number; amount_cents: number; count: number }[];
}

export interface SalesCompare {
  /** Store-local time of day the comparison is cut at. */
  as_of: { hour: number; minute: number };
  days: CompareDay[];
  /** Change of today-so-far against each day up to the same time, in tenths of a percent; null when there is nothing to compare with. */
  vs_yesterday_tenths: number | null;
  vs_last_week_tenths: number | null;
}

/**
 * (now − before) / before in tenths of a percent, rounded half away from zero, integer-only.
 * `null` when `before` is zero: "up ∞%" means nothing to an owner.
 */
export function pctChangeTenths(now: number, before: number): number | null {
  if (before <= 0) return null;
  const diff = now - before;
  const mag = Math.floor((Math.abs(diff) * 2_000 + before) / (2 * before));
  return diff < 0 ? -mag : mag;
}

/** "up 12.5%" / "down 3%" / "level" from tenths. */
export function pctChangeText(tenths: number | null): string | null {
  if (tenths === null) return null;
  if (tenths === 0) return 'level';
  const abs = Math.abs(tenths);
  const text = abs % 10 === 0 ? String(abs / 10) : `${Math.trunc(abs / 10)}.${abs % 10}`;
  return `${tenths > 0 ? 'up' : 'down'} ${text}%`;
}
