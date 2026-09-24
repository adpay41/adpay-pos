/**
 * Register event schemas (ADR 0002). Every sale is a sequence of immutable events with
 * device-generated UUIDs; the server stores them append-only and derives every total by folding.
 * Corrections (void, refund, line removal) are new events — nothing is edited.
 *
 * All payloads are strict objects: an unknown key is rejected, not ignored. That is deliberate —
 * it means there is no field a card number, track data or CVV could ride in on (CLAUDE.md rule 3).
 * The only card facts we ever hold are brand, last four and the processor's opaque reference.
 *
 * Money fields end in `_cents` and are integers; rates end in `_ppm` and are integers.
 */
import { z } from 'zod';
import { Uuid } from './tenancy';

export const EVENT_SCHEMA_VERSION = 1;

const CentsSchema = z.int();
const NonNegCents = z.int().nonnegative();
const RatePpmSchema = z.int().min(0).max(1_000_000);
const Qty = z.int().min(1).max(10_000);

export const PriceModeSchema = z.enum(['cash', 'card']);
export const TenderTypeSchema = z.enum(['cash', 'card']);

const SaleOpened = z.strictObject({
  cashier_user_id: Uuid.nullable(),
  catalog_version: z.int().nonnegative(),
});

/** One per-unit charge on a line, in each price mode (a percentage charge differs by mode). */
const LineChargeSchema = z.strictObject({
  rule_id: Uuid,
  kind: z.enum(['excise', 'deposit', 'fee', 'bag']),
  label: z.string().min(1).max(32),
  unit_cash_cents: NonNegCents,
  unit_card_cents: NonNegCents,
  taxable: z.boolean(),
});

const LineAdded = z.strictObject({
  line_id: Uuid,
  item_id: Uuid,
  name: z.string().min(1).max(200),
  category_id: Uuid.nullable(),
  qty: Qty,
  /** Both posted prices captured at the moment of sale, so replays are historically exact. */
  unit_cash_price_cents: NonNegCents,
  unit_card_price_cents: NonNegCents,
  taxable: z.boolean(),
  tax_rate_ppm: RatePpmSchema,
  min_age: z.int().min(0).max(99).nullable(),
  /** Sold as the unit or as a pack (case-break); `pack_qty` units per pack. */
  sell_unit: z.enum(['each', 'pack']).default('each'),
  pack_qty: z.int().min(1).default(1),
  /**
   * Where the price came from (P5): the catalog; typed at the register for an open-price item
   * (the card price then follows the location's dual-price %); or a price override (P7).
   * Additive: older events default to catalog.
   */
  price_source: z.enum(['catalog', 'open', 'override', 'fee']).default('catalog'),
  /** How it was rung: tapped key, scanned barcode, search result, or a device-created item (P5). */
  entry: z.enum(['key', 'scan', 'search', 'new_item']).default('key'),
  /**
   * Compliance captured at the moment of sale (P10, ADR 0018), all additive: the tax class the rate
   * came from, the restriction kind behind `min_age`, and per-unit charges (deposit, excise, fee).
   */
  tax_class: z.string().max(24).nullable().default(null),
  restriction: z.enum(['tobacco', 'vape', 'alcohol', 'lottery']).nullable().default(null),
  charges: z.array(LineChargeSchema).max(10).default([]),
});

const LineRemoved = z.strictObject({ line_id: Uuid });

/** "Tap the same item twice = qty 2"; long-press to type a quantity (Bible 1.1, P5). */
const LineQtyChanged = z.strictObject({ line_id: Uuid, qty: Qty });

const LineDiscounted = z.strictObject({
  line_id: Uuid,
  /** Discount per line in the price mode of the sale, already rounded once on the device. */
  cash_discount_cents: NonNegCents,
  card_discount_cents: NonNegCents,
  reason: z.string().max(200).nullable(),
});

const AgeVerified = z.strictObject({
  line_id: Uuid,
  method: z.enum(['manual']),
  verified_by_user_id: Uuid.nullable(),
});

const CardResult = z.strictObject({
  provider: z.string().min(1).max(40),
  provider_ref: z.string().min(1).max(200),
  status: z.enum(['approved', 'declined']),
  approval_code: z.string().max(40).nullable(),
  brand: z.string().max(40).nullable(),
  last4: z.string().regex(/^\d{4}$/).nullable(),
});

const TenderAdded = z.strictObject({
  tender_id: Uuid,
  tender_type: TenderTypeSchema,
  /** Amount applied to the sale. */
  amount_cents: NonNegCents,
  /** Cash handed over; change = tendered − amount. Null for card. */
  tendered_cents: NonNegCents.nullable(),
  change_cents: NonNegCents.nullable(),
  card: CardResult.nullable(),
  /**
   * How much of the sale this tender pays for, in cash-price cents (split tender, P9 / ADR 0017).
   * Null on older events: derived by the fold (cash covers what it pays; card covers amount × C/K).
   */
  covers_cash_cents: NonNegCents.nullable().default(null),
});

const SaleCompleted = z.strictObject({
  /** `split`: part cash at the cash price, part card at the card price (P9). */
  price_mode: z.enum(['cash', 'card', 'split']),
  /** Device-computed from the fold at completion; the server re-folds and flags any mismatch. */
  subtotal_cents: CentsSchema,
  tax_cents: CentsSchema,
  total_cents: CentsSchema,
});

const SaleVoided = z.strictObject({
  reason: z.string().max(200),
  by_user_id: Uuid.nullable(),
});

const SaleRefunded = z.strictObject({
  refund_id: Uuid,
  tender_type: TenderTypeSchema,
  amount_cents: NonNegCents,
  reason: z.string().max(200),
  by_user_id: Uuid.nullable(),
  card: CardResult.nullable(),
  /** What came back (P7): units per line, so a sale can't be refunded twice for the same thing. Additive. */
  lines: z.array(z.strictObject({ line_id: Uuid, qty: Qty })).max(500).default([]),
});

/**
 * One exchange with the card terminal (P9, Bible 3.2 "ticket replay incl. terminal request/response").
 * `requested` when the amount goes to the terminal; then the outcome. No card data: brand and last
 * four arrive only on the tender itself.
 */
const CardAttempt = z.strictObject({
  tender_id: Uuid,
  amount_cents: NonNegCents,
  status: z.enum(['requested', 'approved', 'declined', 'error', 'timeout']),
  provider: z.string().min(1).max(40),
  provider_ref: z.string().max(200).nullable(),
  /** Safe to show a cashier ("Insufficient funds"). Never shown to the customer verbatim. */
  message: z.string().max(200).nullable(),
});

const Empty = z.strictObject({});

const ReceiptPrinted = z.strictObject({ copy: z.enum(['original', 'reprint', 'none']) });

const DrawerOpened = z.strictObject({
  /** `manual` = "no sale": opened outside a cash sale, behind the `drawer.no_sale` permission. */
  reason: z.enum(['cash_sale', 'manual', 'refund', 'eod', 'movement', 'count']),
  by_user_id: Uuid.nullable(),
});

// Cash drawer sessions (P6). What the drawer should hold is folded from events (drawer.ts).
const PositiveCents = z.int().positive().max(100_000_000);
const DrawerSessionOpened = z.strictObject({
  session_id: Uuid,
  /** Starting cash, counted when the drawer goes in. */
  float_cents: NonNegCents,
});
const DrawerCashMovement = z.strictObject({
  movement_id: Uuid,
  session_id: Uuid,
  kind: z.enum(['drop', 'paid_out', 'paid_in']),
  amount_cents: PositiveCents,
  reason: z.string().trim().min(1).max(200),
  /** Who was paid (paid-out to a vendor), when it applies. */
  payee: z.string().trim().max(120).nullable(),
});
const DrawerSessionClosed = z.strictObject({
  session_id: Uuid,
  /** The closing count, entered before the expected amount is shown (blind count). */
  counted_cents: NonNegCents,
  blind: z.boolean(),
  /**
   * P15, additive: the count by denomination (key = face value in cents, value = how many), which
   * must add up to `counted_cents`; and a photo of the count sheet (a media id).
   */
  denominations: z.record(z.string().regex(/^\d{1,5}$/), z.int().min(0).max(100_000)).nullable().default(null),
  photo_media_id: Uuid.nullable().default(null),
  /** A shift handover: the next person starts a new session with this count as their float. */
  handover: z.boolean().default(false),
});

/**
 * End of day (P16, spec v1): the register took its Z. It covers this register's events with device_seq in
 * [from_seq, to_seq] (inclusive); the totals are what the register printed. The server re-folds the same range and flags
 * any difference, never edits.
 */
const EodClosed = z.strictObject({
  z_number: z.int().min(1),
  business_date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  from_seq: z.int().nonnegative(),
  to_seq: z.int().nonnegative(),
  totals: z.strictObject({
    sales_count: z.int().nonnegative(),
    gross_cents: CentsSchema,
    tax_cents: CentsSchema,
    voids: z.int().nonnegative(),
    cash_cents: CentsSchema,
    card_cents: CentsSchema,
    refunds_cents: CentsSchema,
  }),
});

/** A bill refused as counterfeit (P15, Bible 1.2): logged with who, when, which register. */
const CounterfeitFlagged = z.strictObject({
  session_id: Uuid.nullable(),
  denomination_cents: z.int().min(100).max(10_000),
  note: z.string().trim().max(200).nullable(),
});

// Staff at the register (P3). PINs are checked on the device; these events are the record.
const StaffSignedIn = z.strictObject({ user_id: Uuid, method: z.enum(['pin']) });
/** Time clock (P15, Bible 1.8). Separate from sign-in: signing in to ring a sale isn't being on the clock. */
const ClockedIn = z.strictObject({ user_id: Uuid });
const ClockedOut = z.strictObject({ user_id: Uuid, reason: z.enum(['manual', 'handover']) });
const StaffSignedOut = z.strictObject({ user_id: Uuid, reason: z.enum(['manual', 'switch', 'idle']) });
const StaffPinFailed = z.strictObject({
  /** Whose PIN was tried (the name tapped). */
  user_id: Uuid,
  purpose: z.enum(['sign_in', 'override']),
  failures: z.int().min(1).max(1000),
  /** True when this failure locked that person out on this register. */
  locked: z.boolean(),
});
/** A manager or owner approved an action the signed-in cashier lacks, with their own PIN. */
const OverrideGranted = z.strictObject({
  action: z.string().min(1).max(40),
  approver_user_id: Uuid,
  for_user_id: Uuid.nullable(),
});

/** Payload schema per event type. Adding a type is additive; changing one bumps the version. */
export const EventPayloads = {
  'sale.opened': SaleOpened,
  'sale.line_added': LineAdded,
  'sale.line_removed': LineRemoved,
  'sale.line_qty_changed': LineQtyChanged,
  'sale.line_discounted': LineDiscounted,
  'sale.age_verified': AgeVerified,
  'sale.tender_added': TenderAdded,
  'sale.card_attempt': CardAttempt,
  'sale.completed': SaleCompleted,
  'sale.voided': SaleVoided,
  'sale.refunded': SaleRefunded,
  'sale.suspended': Empty,
  'sale.resumed': Empty,
  'receipt.printed': ReceiptPrinted,
  'drawer.opened': DrawerOpened,
  'drawer.session_opened': DrawerSessionOpened,
  'drawer.cash_movement': DrawerCashMovement,
  'drawer.session_closed': DrawerSessionClosed,
  'drawer.counterfeit': CounterfeitFlagged,
  'eod.closed': EodClosed,
  'staff.clocked_in': ClockedIn,
  'staff.clocked_out': ClockedOut,
  'staff.signed_in': StaffSignedIn,
  'staff.signed_out': StaffSignedOut,
  'staff.pin_failed': StaffPinFailed,
  'override.granted': OverrideGranted,
} as const;

export type EventType = keyof typeof EventPayloads;
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];

/** Events that belong to a sale must carry its sale_id; these may stand alone (sale_id null). */
const SALELESS: ReadonlySet<EventType> = new Set([
  'drawer.opened',
  'drawer.session_opened',
  'drawer.cash_movement',
  'drawer.session_closed',
  'drawer.counterfeit',
  'eod.closed',
  'staff.clocked_in',
  'staff.clocked_out',
  'staff.signed_in',
  'staff.signed_out',
  'staff.pin_failed',
  'override.granted',
]);

const EnvelopeBase = z.strictObject({
  event_id: Uuid,
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  sale_id: Uuid.nullable(),
  /** Monotonic per register; lets the server spot gaps in what a device has sent. */
  device_seq: z.int().nonnegative(),
  occurred_at: z.iso.datetime({ offset: true }),
  org_id: Uuid,
  merchant_id: Uuid,
  location_id: Uuid,
  register_id: Uuid,
  trace_id: z.string().min(1).max(64),
  /**
   * Who was signed in at the register when this happened (P3). Null before sign-in existed, and
   * for a register whose merchant has not set up any PINs yet. Additive: older events omit it.
   */
  actor_user_id: Uuid.nullable().default(null),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  payload: z.unknown(),
});

export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export type RegisterEvent = {
  [T in EventType]: Omit<z.infer<typeof EnvelopeBase>, 'type' | 'payload'> & { type: T; payload: EventPayload<T> };
}[EventType];

export const RegisterEventSchema = EnvelopeBase.transform((env, ctx) => {
  const schema = EventPayloads[env.type];
  const parsed = schema.safeParse(env.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ['payload', ...issue.path] } as never);
    }
    return z.NEVER;
  }
  if (env.sale_id === null && !SALELESS.has(env.type)) {
    ctx.addIssue({ code: 'custom', path: ['sale_id'], message: `${env.type} requires sale_id` });
    return z.NEVER;
  }
  return { ...env, payload: parsed.data } as RegisterEvent;
});

export const EventBatchSchema = z.strictObject({
  events: z.array(z.unknown()).min(1).max(500),
});

export function parseRegisterEvent(input: unknown): RegisterEvent {
  return RegisterEventSchema.parse(input);
}
