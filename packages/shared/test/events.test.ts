import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { foldSale, parseRegisterEvent, saleNetCents, type RegisterEvent } from '../src';

const tenancy = {
  org_id: randomUUID(),
  merchant_id: randomUUID(),
  location_id: randomUUID(),
  register_id: randomUUID(),
};

let seq = 0;
function ev(type: string, sale_id: string | null, payload: unknown): unknown {
  return {
    event_id: randomUUID(),
    schema_version: 1,
    sale_id,
    device_seq: seq++,
    occurred_at: '2026-09-23T13:05:00.000Z',
    ...tenancy,
    trace_id: 'test',
    type,
    payload,
  };
}

function line(sale: string, cash: number, card: number, qty = 1, taxable = true) {
  return ev('sale.line_added', sale, {
    line_id: randomUUID(),
    item_id: randomUUID(),
    name: 'Bacon egg & cheese',
    category_id: null,
    qty,
    unit_cash_price_cents: cash,
    unit_card_price_cents: card,
    taxable,
    tax_rate_ppm: 66_250,
    min_age: null,
  });
}

describe('event schema', () => {
  it('parses a valid event and fills defaults', () => {
    const e = parseRegisterEvent(line(randomUUID(), 699, 727));
    expect(e.type).toBe('sale.line_added');
    if (e.type === 'sale.line_added') expect(e.payload.sell_unit).toBe('each');
  });

  it('rejects float money', () => {
    expect(() => parseRegisterEvent(line(randomUUID(), 6.99, 7.27))).toThrow();
  });

  it('has nowhere to put card data: unknown keys are rejected', () => {
    const sale = randomUUID();
    const tender = {
      tender_id: randomUUID(),
      tender_type: 'card',
      amount_cents: 1000,
      tendered_cents: null,
      change_cents: null,
      card: { provider: 'stub', provider_ref: 'x', status: 'approved', approval_code: null, brand: 'visa', last4: '4242' },
    };
    expect(() => parseRegisterEvent(ev('sale.tender_added', sale, tender))).not.toThrow();
    expect(() => parseRegisterEvent(ev('sale.tender_added', sale, { ...tender, pan: '4111111111111111' }))).toThrow();
    expect(() =>
      parseRegisterEvent(ev('sale.tender_added', sale, { ...tender, card: { ...tender.card, cvv: '123' } })),
    ).toThrow();
    expect(() =>
      parseRegisterEvent(ev('sale.tender_added', sale, { ...tender, card: { ...tender.card, last4: '411111' } })),
    ).toThrow();
  });

  it('requires sale_id on sale events', () => {
    expect(() => parseRegisterEvent(line(null as unknown as string, 100, 104))).toThrow();
  });
});

describe('foldSale', () => {
  it('derives totals in both price modes and detects declared mismatches', () => {
    const sale = randomUUID();
    const events = [
      ev('sale.opened', sale, { cashier_user_id: null, catalog_version: 1 }),
      line(sale, 899, 935, 1),
      line(sale, 249, 259, 2),
      line(sale, 1450, 1450, 1, false),
      ev('sale.tender_added', sale, {
        tender_id: randomUUID(),
        tender_type: 'cash',
        amount_cents: 3014,
        tendered_cents: 4000,
        change_cents: 986,
        card: null,
      }),
      ev('sale.completed', sale, { price_mode: 'cash', subtotal_cents: 2847, tax_cents: 93, total_cents: 2940 }),
    ].map(parseRegisterEvent);

    const folded = foldSale(sale, events);
    // taxable cash net = 899 + 498 = 1397 -> 6.625% = 92.55 -> 93
    expect(folded.cash).toEqual({ subtotal_cents: 2847, tax_cents: 93, total_cents: 2940 });
    expect(folded.card.subtotal_cents).toBe(935 + 518 + 1450);
    expect(folded.status).toBe('completed');
    expect(folded.mismatch).toBe(false);
    expect(folded.paid_cents).toBe(3014);

    const lying = [...events.slice(0, -1), parseRegisterEvent(ev('sale.completed', sale, {
      price_mode: 'cash', subtotal_cents: 2847, tax_cents: 90, total_cents: 2937,
    }))];
    expect(foldSale(sale, lying).mismatch).toBe(true);
  });

  it('treats voids and refunds as new events and ignores duplicates', () => {
    const sale = randomUUID();
    const opened = parseRegisterEvent(ev('sale.opened', sale, { cashier_user_id: null, catalog_version: 1 }));
    const l = parseRegisterEvent(line(sale, 500, 520));
    const t = parseRegisterEvent(ev('sale.tender_added', sale, {
      tender_id: randomUUID(), tender_type: 'cash', amount_cents: 533, tendered_cents: 533, change_cents: 0, card: null,
    }));
    const done = parseRegisterEvent(ev('sale.completed', sale, {
      price_mode: 'cash', subtotal_cents: 500, tax_cents: 33, total_cents: 533,
    }));
    const refund = parseRegisterEvent(ev('sale.refunded', sale, {
      refund_id: randomUUID(), tender_type: 'cash', amount_cents: 200, reason: 'stale', by_user_id: null, card: null,
    }));
    const base: RegisterEvent[] = [opened, l, l, t, t, done];
    expect(saleNetCents(foldSale(sale, base))).toBe(533);
    expect(saleNetCents(foldSale(sale, [...base, refund]))).toBe(333);
    const voided = parseRegisterEvent(ev('sale.voided', sale, { reason: 'test', by_user_id: null }));
    expect(saleNetCents(foldSale(sale, [...base, voided]))).toBe(0);
  });

  it('property: a day of random cash sales reconciles to the cent', () => {
    let rng = 42;
    const next = (n: number) => {
      rng = (rng * 1_103_515_245 + 12_345) % 2 ** 31;
      return rng % n;
    };
    let expectedDrawer = 0;
    let foldedDrawer = 0;
    for (let s = 0; s < 300; s++) {
      const sale = randomUUID();
      const lines = Array.from({ length: 1 + next(5) }, () => {
        const cash = 50 + next(2000);
        return parseRegisterEvent(line(sale, cash, cash + next(100), 1 + next(3), next(3) > 0));
      });
      const provisional = foldSale(sale, lines);
      const total = provisional.cash.total_cents;
      const tender = parseRegisterEvent(ev('sale.tender_added', sale, {
        tender_id: randomUUID(), tender_type: 'cash', amount_cents: total, tendered_cents: total, change_cents: 0, card: null,
      }));
      const done = parseRegisterEvent(ev('sale.completed', sale, { price_mode: 'cash', ...provisional.cash }));
      const folded = foldSale(sale, [...lines, tender, done]);
      expect(Number.isInteger(folded.cash.total_cents)).toBe(true);
      expect(folded.mismatch).toBe(false);
      expectedDrawer += total;
      foldedDrawer += saleNetCents(folded);
    }
    expect(foldedDrawer).toBe(expectedDrawer);
  });
});
