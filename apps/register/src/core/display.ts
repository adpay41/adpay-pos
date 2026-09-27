/**
 * Customer display channel. The register publishes what the customer should see; the customer screen
 * renders it. On Android the customer screen is an Android Presentation on the 10.1" display (Kotlin
 * module, later in step 2). In the browser it's a second window at `?display=customer`, fed over a
 * BroadcastChannel, so both screens can sit side by side on a laptop.
 *
 * Spec: the customer sees cash price and card price side by side before tender, every sale.
 */
import { lineAmount, type FoldedSale, type Lang, type Overrides } from '@adpay/shared';

/**
 * The customer screen's states (Bible 1.5): idle → cart → card ("tap on the card machine") →
 * approved / declined → paid (thank you + change). The register drives it; the screen only shows.
 */
export type DisplayPhase = 'idle' | 'cart' | 'card' | 'approved' | 'declined' | 'paid';

export interface DisplayState {
  phase: DisplayPhase;
  merchant_name: string;
  lines: { line_id: string; name: string; qty: number; cash_cents: number; card_cents: number; deal: { kind: 'promo'; name: string } | { kind: 'reward' } | null }[];
  cash_total_cents: number;
  card_total_cents: number;
  tax_cash_cents: number;
  tax_card_cents: number;
  paid_cents: number | null;
  change_cents: number | null;
  /** Card phases: the amount on the terminal. */
  card_amount_cents: number | null;
  /** Split tender: what's been paid so far (cash part and/or earlier cards). */
  paid_so_far_cents: number | null;
  /** The customer screen's language and the ones the customer can switch to (P18). */
  language: Lang;
  languages: Lang[];
  overrides: Overrides;
  /** Paid phase: the digital receipt link, shown as a QR (P18). */
  receipt_url: string | null;
  /**
   * Loyalty on the customer screen (P19a): offered when the store runs a program. `status` is null
   * until the server answers (or offline, with `offline`).
   */
  loyalty: {
    ask_texts: boolean;
    last4: string | null;
    status: { kind: 'visits' | 'points'; balance: number; needed: number; rewards_available: number; to_next: number } | null;
    offline: boolean;
    redeemed: boolean;
  } | null;
  /** Paid phase: what happened to "text me my receipt". */
  receipt_text: 'sent' | 'not_delivered' | 'failed' | null;
  /** Idle: the store's running deals, as the customer reads them (P20a, Bible 1.5 deals of the day). */
  deals: string[];
}

/** Language context the register adds to every state it publishes (P18). */
export type DisplayContext = Pick<DisplayState, 'language' | 'languages' | 'overrides' | 'receipt_url' | 'loyalty' | 'receipt_text' | 'deals'>;
const NO_CONTEXT: DisplayContext = { language: 'en', languages: ['en'], overrides: {}, receipt_url: null, loyalty: null, receipt_text: null, deals: [] };

/** What the customer screen sends back: a language, or a phone number for rewards or the receipt (P19a). */
export type CustomerMessage =
  | { kind: 'customer_language'; language: Lang }
  | { kind: 'customer_phone'; purpose: 'loyalty' | 'receipt'; phone: string; marketing_opt_in: boolean };

export function displayFor(
  merchantName: string,
  sale: FoldedSale | null,
  paid?: { amount: number; change: number },
  card?: { phase: 'card' | 'approved' | 'declined'; amount: number },
): DisplayState {
  if (card && sale) {
    const soFar = sale.tenders.filter((t) => t.approved).reduce((n, t) => n + t.amount_cents, 0);
    return { ...base(merchantName, sale), phase: card.phase, card_amount_cents: card.amount, paid_so_far_cents: soFar || null };
  }
  if (paid && sale) {
    return {
      ...base(merchantName, sale),
      phase: 'paid',
      paid_cents: paid.amount,
      change_cents: paid.change,
    };
  }
  if (!sale || sale.lines.length === 0) {
    return {
      phase: 'idle', merchant_name: merchantName, lines: [], cash_total_cents: 0, card_total_cents: 0,
      tax_cash_cents: 0, tax_card_cents: 0, paid_cents: null, change_cents: null, card_amount_cents: null, paid_so_far_cents: null, ...NO_CONTEXT,
    };
  }
  return base(merchantName, sale);
}

function base(merchantName: string, sale: FoldedSale): DisplayState {
  return {
    phase: 'cart',
    merchant_name: merchantName,
    lines: sale.lines.map((l) => ({
      line_id: l.line_id,
      name: l.name,
      qty: l.qty,
      // The customer screen has no discount row: a basket share comes off the line itself (ADR 0048).
      cash_cents: lineAmount(l, 'cash') - l.basket_cash_cents,
      card_cents: lineAmount(l, 'card') - l.basket_card_cents,
      deal: l.discount_promo_id && l.discount_reason ? { kind: 'promo', name: l.discount_reason.replace(/^Promo: /, '') } : l.discount_reason === 'Loyalty reward' ? { kind: 'reward' } : null,
    })),
    cash_total_cents: sale.cash.total_cents,
    card_total_cents: sale.card.total_cents,
    tax_cash_cents: sale.cash.tax_cents,
    tax_card_cents: sale.card.tax_cents,
    paid_cents: null,
    change_cents: null,
    card_amount_cents: null,
    paid_so_far_cents: null,
    ...NO_CONTEXT,
  };
}

const CHANNEL = 'adpay-customer-display';

export interface DisplayChannel {
  publish(state: DisplayState): void;
  subscribe(fn: (state: DisplayState) => void): () => void;
  /** Customer screen → register (P18). */
  send(msg: CustomerMessage): void;
  onCustomer(fn: (msg: CustomerMessage) => void): () => void;
}

/** BroadcastChannel where available (browser); a no-op elsewhere until the Presentation module lands. */
export function createDisplayChannel(): DisplayChannel {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!BC) return { publish: () => undefined, subscribe: () => () => undefined, send: () => undefined, onCustomer: () => () => undefined };
  const ch = new BC(CHANNEL);
  let last: DisplayState | null = null;
  // A customer window opened mid-sale asks for the current state.
  ch.addEventListener('message', (e: MessageEvent) => {
    if (e.data === 'hello' && last) ch.postMessage(last);
  });
  return {
    publish(state) {
      last = state;
      ch.postMessage(state);
    },
    subscribe(fn) {
      const rx = new BC(CHANNEL);
      rx.addEventListener('message', (e: MessageEvent) => {
        if (e.data && typeof e.data === 'object' && 'phase' in e.data) fn(e.data as DisplayState);
      });
      rx.postMessage('hello');
      return () => rx.close();
    },
    send(msg) {
      ch.postMessage(msg);
    },
    onCustomer(fn) {
      const rx = new BC(CHANNEL);
      rx.addEventListener('message', (e: MessageEvent) => {
        const kind = e.data && typeof e.data === 'object' ? (e.data as CustomerMessage).kind : null;
        if (kind === 'customer_language' || kind === 'customer_phone') fn(e.data as CustomerMessage);
      });
      return () => rx.close();
    },
  };
}
