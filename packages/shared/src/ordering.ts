/**
 * Vendors, reorder suggestions and purchase orders (Bible 2.4; build plan P23, ADR 0035).
 *
 * A suggestion is what to order from a vendor now so the shelf lasts until the delivery after next:
 * the expected sales for each day until then (the same weekday's average over the last four weeks,
 * which catches the weekend spikes), plus the item's low-stock point as a buffer, minus what's on the
 * shelf and already on order, rounded up to the case.
 */
import { z } from 'zod';

const Phone = z.string().trim().regex(/^\+?1?[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{4}$/, 'A US phone number');

export const VendorInput = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    phone: Phone.nullable().default(null),
    email: z.email().max(200).nullable().default(null),
    /** How orders go out: a text or an email to the rep. */
    order_via: z.enum(['sms', 'email']).default('sms'),
    /** 0 = Sunday … 6 = Saturday. */
    delivery_days: z.array(z.int().min(0).max(6)).max(7).default([]),
    note: z.string().trim().max(200).nullable().default(null),
  })
  .refine((v) => (v.order_via === 'sms' ? v.phone !== null : v.email !== null), { message: 'Give the phone or email the orders go to', path: ['order_via'] });
export type VendorInput = z.infer<typeof VendorInput>;

export const PurchaseOrderInput = z.strictObject({
  vendor_id: z.uuid(),
  location_id: z.uuid(),
  lines: z.array(z.strictObject({ item_id: z.uuid(), qty: z.int().min(1).max(100_000) })).min(1).max(300),
  note: z.string().trim().max(200).nullable().default(null),
});
export type PurchaseOrderInput = z.infer<typeof PurchaseOrderInput>;

/** The next `count` delivery dates on or after `from` (YYYY-MM-DD) for these weekdays. */
export function nextDeliveries(from: string, days: readonly number[], count: number): string[] {
  if (!days.length) return [];
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 1; out.length < count && i <= 7 * count + 7; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    if (days.includes(day.getUTCDay())) out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

export interface ReorderInput {
  item_id: string;
  on_hand: number;
  on_order: number;
  reorder_point: number | null;
  /** Units sold per day for the last 28 days, oldest first, ending yesterday. */
  daily_units: readonly number[];
  /** Units in a case, when the item has a case barcode; orders round up to it. */
  case_qty: number;
}

/**
 * How many to order now. `today` is the store-local date; the order has to last from today until the
 * delivery after next (or a week, for a vendor with no delivery days set).
 */
export function suggestReorder(r: ReorderInput, today: string, deliveryDays: readonly number[]): { qty: number; forecast: number; until: string } {
  const [, second] = nextDeliveries(today, deliveryDays, 2);
  const until = second ?? new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  // Average per weekday over the last four weeks (daily_units[27] is yesterday).
  const byWeekday = Array.from({ length: 7 }, () => ({ units: 0, days: 0 }));
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000);
  r.daily_units.forEach((u, i) => {
    const day = new Date(yesterday.getTime() - (r.daily_units.length - 1 - i) * 86_400_000).getUTCDay();
    byWeekday[day]!.units += u;
    byWeekday[day]!.days += 1;
  });
  // Tenths of a unit, to keep the sum honest without floats; rounded up at the end.
  let forecastTenths = 0;
  for (let d = new Date(`${today}T12:00:00Z`); d.toISOString().slice(0, 10) < until; d = new Date(d.getTime() + 86_400_000)) {
    const w = byWeekday[d.getUTCDay()]!;
    if (w.days) forecastTenths += Math.round((w.units * 10) / w.days);
  }
  const forecast = Math.ceil(forecastTenths / 10);
  const need = forecast + (r.reorder_point ?? 0) - r.on_hand - r.on_order;
  if (need <= 0) return { qty: 0, forecast, until };
  const cq = Math.max(1, r.case_qty);
  return { qty: Math.ceil(need / cq) * cq, forecast, until };
}

/** The order message a rep receives. */
export function orderText(store: string, vendor: string, lines: readonly { name: string; qty: number }[], note: string | null): string {
  return [`Order from ${store} for ${vendor}:`, ...lines.map((l) => `${l.qty} × ${l.name}`), ...(note ? [note] : []), 'Thank you!'].join('\n');
}
