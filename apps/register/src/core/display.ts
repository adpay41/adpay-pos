/**
 * Customer display channel. The register publishes what the customer should see; the customer screen
 * renders it. On Android the customer screen is an Android Presentation on the 10.1" display (Kotlin
 * module, later in step 2). In the browser it's a second window at `?display=customer`, fed over a
 * BroadcastChannel, so both screens can sit side by side on a laptop.
 *
 * Spec: the customer sees cash price and card price side by side before tender, every sale.
 */
import { lineTotal, type FoldedSale } from '@adpay/shared';

/**
 * The customer screen's states (Bible 1.5): idle → cart → card ("tap on the card machine") →
 * approved / declined → paid (thank you + change). The register drives it; the screen only shows.
 */
export type DisplayPhase = 'idle' | 'cart' | 'card' | 'approved' | 'declined' | 'paid';

export interface DisplayState {
  phase: DisplayPhase;
  merchant_name: string;
  lines: { line_id: string; name: string; qty: number; cash_cents: number; card_cents: number }[];
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
}

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
      tax_cash_cents: 0, tax_card_cents: 0, paid_cents: null, change_cents: null, card_amount_cents: null, paid_so_far_cents: null,
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
      cash_cents: lineTotal(l, 'cash'),
      card_cents: lineTotal(l, 'card'),
    })),
    cash_total_cents: sale.cash.total_cents,
    card_total_cents: sale.card.total_cents,
    tax_cash_cents: sale.cash.tax_cents,
    tax_card_cents: sale.card.tax_cents,
    paid_cents: null,
    change_cents: null,
    card_amount_cents: null,
    paid_so_far_cents: null,
  };
}

const CHANNEL = 'adpay-customer-display';

export interface DisplayChannel {
  publish(state: DisplayState): void;
  subscribe(fn: (state: DisplayState) => void): () => void;
}

/** BroadcastChannel where available (browser); a no-op elsewhere until the Presentation module lands. */
export function createDisplayChannel(): DisplayChannel {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!BC) return { publish: () => undefined, subscribe: () => () => undefined };
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
        if (e.data && typeof e.data === 'object') fn(e.data as DisplayState);
      });
      rx.postMessage('hello');
      return () => rx.close();
    },
  };
}
