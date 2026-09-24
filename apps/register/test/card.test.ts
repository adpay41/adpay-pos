/**
 * Card tender on the register (P9): the request/response pair in the log, declines leaving the
 * ticket open, split tender at each portion's price, two cards, and card refunds.
 */
import { randomUUID } from 'node:crypto';
import { cardAmountFor, cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleError, SaleSession, type CardRefunder } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const PLATTER: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Party platter', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 2_000,
  card_price_cents: 2_080, card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 66_250, min_age: null,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};
const approved = (ref = `stub_${randomUUID().slice(0, 8)}`) =>
  ({ status: 'approved', provider: 'stub', provider_ref: ref, approval_code: 'A1B2C3', brand: 'visa', last4: '4242', message: null }) as const;

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  await session.addItem(PLATTER);
  return { store, session };
}

describe('card tender', () => {
  it('charges the card price; request and approval are both in the log; completes as a card sale', async () => {
    const { session, store } = await setup();
    const sale = session.state().sale!;
    const { tender_id, amount } = await session.startCard();
    expect(amount).toBe(sale.card.total_cents); // 2080 + 6.625% = 2218
    const r = await session.finishCard(tender_id, amount, approved());
    expect(r.completed).toBe(true);
    expect(r.sale).toMatchObject({ status: 'completed', price_mode: 'card', paid_cents: 2_218, mismatch: false });
    expect(r.sale.tenders[0]!.card).toMatchObject({ brand: 'visa', last4: '4242' });
    const types = (await store.unacked(100)).map((e) => (e.type === 'sale.card_attempt' ? `card:${e.payload.status}` : e.type));
    expect(types.slice(-4)).toEqual(['card:requested', 'card:approved', 'sale.tender_added', 'sale.completed']);
  });

  it('a decline is recorded and leaves the ticket open; cash still finishes it', async () => {
    const { session } = await setup();
    const { tender_id, amount } = await session.startCard();
    const r = await session.finishCard(tender_id, amount, { status: 'declined', provider: 'stub', provider_ref: 'x', approval_code: null, brand: null, last4: null, message: 'Insufficient funds' });
    expect(r.completed).toBe(false);
    expect(session.state().sale!.status).toBe('open');
    const done = await session.tenderCash(cents(3_000));
    expect(done.sale.price_mode).toBe('cash');
  });

  it('split: $5 cash at the cash price, the rest on card at the card price, no mismatch', async () => {
    const { session } = await setup();
    const sale = session.state().sale!;
    const part = await session.tenderCash(cents(500), { partial: true });
    expect(part.completed).toBe(false);
    const left = part.sale.remaining_cash_cents;
    expect(left).toBe(sale.cash.total_cents - 500);
    const { tender_id, amount } = await session.startCard();
    expect(amount).toBe(cardAmountFor(left, sale.cash.total_cents, sale.card.total_cents));
    const r = await session.finishCard(tender_id, amount, approved());
    expect(r.sale).toMatchObject({ status: 'completed', price_mode: 'split', remaining_cash_cents: 0, mismatch: false });
    expect(r.sale.paid_cents).toBe(500 + amount);
    expect(r.sale.paid_cents).toBeGreaterThan(sale.cash.total_cents);
    expect(r.sale.paid_cents).toBeLessThan(sale.card.total_cents);
  });

  it('two cards: part on one, the rest on another', async () => {
    const { session } = await setup();
    const first = await session.startCard(cents(1_000));
    expect((await session.finishCard(first.tender_id, first.amount, approved())).completed).toBe(false);
    const second = await session.startCard();
    const r = await session.finishCard(second.tender_id, second.amount, approved());
    expect(r.sale).toMatchObject({ status: 'completed', price_mode: 'card', mismatch: false });
    expect(r.sale.tenders.filter((t) => t.approved)).toHaveLength(2);
  });

  it('refuses charging more than is due', async () => {
    const { session } = await setup();
    await expect(session.startCard(cents(999_999))).rejects.toBeInstanceOf(SaleError);
  });
});

describe('card refunds', () => {
  it('goes back to the card through the processor; declined or offline refunds change nothing', async () => {
    const { session } = await setup();
    const { tender_id, amount } = await session.startCard();
    const { sale } = await session.finishCard(tender_id, amount, approved('stub_charge1'));
    const line = sale.lines[0]!.line_id;

    await expect(session.refund(sale.sale_id, [{ line_id: line, qty: 1 }], 'Returned')).rejects.toThrow(/online/);
    const declines: CardRefunder = async () => ({ status: 'declined', provider: 'stub', provider_ref: null, approval_code: null, message: 'Refund declined' });
    await expect(session.refund(sale.sale_id, [{ line_id: line, qty: 1 }], 'Returned', declines)).rejects.toThrow(/declined/);
    expect((await session.saleById(sale.sale_id))!.refunded_cents).toBe(0);

    const asked: { provider_ref: string; amount_cents: number }[] = [];
    const ok: CardRefunder = async (req) => {
      asked.push(req);
      return { status: 'approved', provider: 'stub', provider_ref: 'stub_refund1', approval_code: null, message: null };
    };
    const r = await session.refund(sale.sale_id, [{ line_id: line, qty: 1 }], 'Returned', ok);
    expect(r).toMatchObject({ tender: 'card', amount: 2_218 });
    expect(asked).toEqual([expect.objectContaining({ provider_ref: 'stub_charge1', amount_cents: 2_218 })]);
  });

  it('voiding a split sale returns each part to how it was paid', async () => {
    const { session } = await setup();
    await session.tenderCash(cents(500), { partial: true });
    const { tender_id, amount } = await session.startCard();
    const { sale } = await session.finishCard(tender_id, amount, approved('stub_split1'));
    const refunds: number[] = [];
    const v = await session.voidCompleted(sale.sale_id, 'Mistake', async (req) => {
      refunds.push(req.amount_cents);
      return { status: 'approved', provider: 'stub', provider_ref: 'r', approval_code: null, message: null };
    });
    expect(refunds).toEqual([amount]); // card part back to the card
    expect(v.amount).toBe(500 + amount); // cash part from the drawer, card part to the card
    expect(v.sale.status).toBe('voided');
    // A split sale can't be partly refunded.
    await expect(session.refund(sale.sale_id, [{ line_id: sale.lines[0]!.line_id, qty: 1 }], 'x')).rejects.toThrow();
  });
});
