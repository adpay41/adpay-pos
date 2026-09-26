/**
 * Languages on the register (P18): the customer's language and the digital-receipt token are
 * captured on sale.completed; the customer display carries the language context; the receipt prints
 * in the captured language with the digital-copy QR.
 */
import { randomUUID } from 'node:crypto';
import { cents, receiptText, renderReceipt, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { displayFor } from '../src/core/display';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const COFFEE: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Hot Coffee — Large', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 275,
  card_price_cents: 286, card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 66_250, min_age: null,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};

async function sell(ctx?: { language: 'en' | 'es' | 'ko'; digital_receipt: boolean }) {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  if (ctx) session.setCompletionContext(ctx);
  await session.addItem(COFFEE);
  const r = await session.tenderCash(cents(500));
  const completed = (await store.unacked(100)).find((e) => e.type === 'sale.completed')!;
  return { sale: r.sale, payload: completed.payload as Record<string, unknown> };
}

describe('customer language on the sale', () => {
  it('records the language and mints a random receipt token', async () => {
    const { sale, payload } = await sell({ language: 'ko', digital_receipt: true });
    expect(payload.language).toBe('ko');
    expect(payload.receipt_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.receipt_token).not.toBe(sale.sale_id);
    expect(sale).toMatchObject({ language: 'ko', receipt_token: payload.receipt_token });
  });

  it('English and no digital receipt leave the event as it always was', async () => {
    const { payload } = await sell({ language: 'en', digital_receipt: false });
    expect(Object.keys(payload).sort()).toEqual(['price_mode', 'subtotal_cents', 'tax_cents', 'total_cents']);
    expect(Object.keys((await sell()).payload)).not.toContain('receipt_token');
  });

  it('the receipt prints in the captured language with the digital-copy QR', async () => {
    const { sale } = await sell({ language: 'es', digital_receipt: true });
    const lines = renderReceipt({
      header: { merchant_name: 'Deli', location_name: 'JC', address_line1: null, city_state_zip: null, register_name: 'R1' },
      sale, occurred_at: new Date().toISOString(), timezone: 'America/New_York', copy: 'original',
      digital_url: `http://localhost:3000/r/${sale.receipt_token}`,
    });
    expect(receiptText(lines)).toMatch(/Cambio\s+\$2\.07/);
    expect(lines.find((l) => l.style === 'qr')).toMatchObject({ data: `http://localhost:3000/r/${sale.receipt_token}` });
  });
});

describe('customer display state', () => {
  it('starts in English with no link; the register adds its language context', () => {
    expect(displayFor('Deli', null)).toMatchObject({ phase: 'idle', language: 'en', languages: ['en'], receipt_url: null });
  });
});
