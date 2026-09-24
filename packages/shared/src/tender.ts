/**
 * Cash tender arithmetic. Integer cents only; the register never computes change any other way.
 */
import { cents, sub, type Cents } from './money';

export class TenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenderError';
  }
}

/** Change owed for cash handed over. Throws if the customer has not handed over enough. */
export function changeDue(total: Cents, tendered: Cents): Cents {
  if (tendered < total) throw new TenderError(`tendered ${tendered} is less than total ${total}`);
  return sub(tendered, total);
}

const BILLS = [100, 500, 1000, 2000, 5000, 10000] as const;

/**
 * Quick-cash buttons for a total: exact, the next whole dollar, and the next few bills that cover
 * it — the amounts a customer actually hands over at a deli counter. Deduplicated, ascending.
 */
export function quickCashOptions(total: Cents, max = 7): Cents[] {
  const t = cents(total);
  const options = new Set<number>([t]);
  if (t % 100 !== 0) options.add(Math.ceil(t / 100) * 100);
  for (const bill of BILLS) {
    if (bill >= t) options.add(bill);
    else if (bill >= 500) options.add(Math.ceil(t / bill) * bill);
  }
  return [...options]
    .filter((v) => v >= t)
    .sort((a, b) => a - b)
    .slice(0, max)
    .map(cents);
}
