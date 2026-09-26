import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cellWidth,
  coverage,
  EN,
  foldSale,
  LANG_CODES,
  CUSTOMER_KEYS,
  offeredLanguages,
  parseRegisterEvent,
  placeholdersMatch,
  RECEIPT_WIDTH,
  receiptText,
  renderReceipt,
  sliceCells,
  translate,
  wrap,
} from '../src';
import { BUILT_IN } from '../src/i18n-messages';

describe('message catalogs', () => {
  it('every built-in translation keeps the English placeholders', () => {
    for (const lang of LANG_CODES) {
      for (const [key, text] of Object.entries(BUILT_IN[lang])) {
        expect(placeholdersMatch(key as keyof typeof EN, text!), `${lang}.${key}`).toBe(true);
      }
    }
  });

  it('all eight Bible languages are complete', () => {
    for (const lang of LANG_CODES) expect(coverage(lang).missing, lang).toEqual([]);
  });

  it('fills values, prefers overrides, and falls back to English', () => {
    expect(translate('es', 'r_each', { price: '$2.75' })).toBe('@ $2.75 c/u');
    expect(translate('es', 'thanks', undefined, { es: { thanks: '¡Mil gracias!' } })).toBe('¡Mil gracias!');
    expect(coverage('ko', { ko: {} }).total).toBe(CUSTOMER_KEYS.length);
  });

  it('a placeholder dropped by a translation is caught', () => {
    expect(placeholdersMatch('r_each', '@ cada uno')).toBe(false);
    expect(placeholdersMatch('r_tax_rate', 'Impuesto {amount} al {rate}%')).toBe(true);
  });

  it('offers English first, never a draft, no duplicates', () => {
    expect(offeredLanguages(['es', 'gu', 'es', 'zh'], {})).toEqual(['en', 'es', 'zh']);
    expect(offeredLanguages(['gu'], { gu: 'reviewed' })).toEqual(['en', 'gu']);
    expect(offeredLanguages(['es'], { es: 'draft' })).toEqual(['en']);
  });
});

describe('printer columns', () => {
  it('counts CJK as two columns and combining marks as none', () => {
    expect(cellWidth('abc')).toBe(3);
    expect(cellWidth('小计')).toBe(4);
    expect(cellWidth('합계')).toBe(4);
    expect(cellWidth('कुल')).toBe(2); // क + ु (mark) + ल
    expect(sliceCells('现金价总额', 5)).toBe('现金');
  });

  it('wraps unspaced Chinese without overflowing', () => {
    const lines = wrap('付款前会同时显示现金价和刷卡价。'.repeat(4), 20);
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(20);
    expect(lines.join('')).toBe('付款前会同时显示现金价和刷卡价。'.repeat(4));
  });
});

describe('receipt in the customer language', () => {
  const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
  const sale = randomUUID();
  const token = randomUUID();
  let seq = 0;
  const ev = (type: string, payload: unknown) =>
    parseRegisterEvent({ event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++, occurred_at: '2026-09-23T12:15:00.000Z', ...t, trace_id: 'r', type, payload });
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', { line_id: randomUUID(), item_id: randomUUID(), name: 'Hot Coffee — Large', category_id: null, qty: 2, unit_cash_price_cents: 275, unit_card_price_cents: 286, taxable: true, tax_rate_ppm: 66_250, min_age: null }),
  ];
  const open = foldSale(sale, events);
  events.push(
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: open.cash.total_cents, tendered_cents: 1000, change_cents: 1000 - open.cash.total_cents, card: null }),
    ev('sale.completed', { price_mode: 'cash', ...open.cash, language: 'zh', receipt_token: token }),
  );
  const folded = foldSale(sale, events);
  const render = (extra: object = {}) =>
    renderReceipt({
      header: { merchant_name: 'Journal Square Deli', location_name: 'Jersey City', address_line1: null, city_state_zip: null, register_name: 'Register 1' },
      sale: folded, occurred_at: '2026-09-23T12:15:00.000Z', timezone: 'America/New_York', copy: 'original', ...extra,
    });

  it('carries the language and token from sale.completed', () => {
    expect(folded.language).toBe('zh');
    expect(folded.receipt_token).toBe(token);
  });

  it('prints in the sale language, amounts unchanged, within 48 printer columns', () => {
    const lines = render();
    const text = receiptText(lines);
    expect(text).toMatch(/总计\s+\$5\.86/);
    expect(text).toMatch(/找零\s+\$4\.14/);
    expect(text).toContain('现金价总额');
    expect(text).toContain('谢谢！');
    expect(text).toContain('Hot Coffee — Large'); // item names print as the store wrote them
    for (const l of lines) expect(cellWidth(l.text)).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });

  it('a reprint can be asked for in another language', () => {
    expect(receiptText(render({ lang: 'es', copy: 'reprint' }))).toMatch(/REIMPRESIÓN[\s\S]*TOTAL\s+\$5\.86[\s\S]*Cambio\s+\$4\.14/);
  });

  it('adds the digital-copy QR only when there is a URL and a token', () => {
    const url = `https://example.test/r/${token}`;
    const withQr = render({ digital_url: url });
    expect(withQr.find((l) => l.style === 'qr')).toMatchObject({ data: url });
    expect(render().some((l) => l.style === 'qr')).toBe(false);
  });

  it('a store-written footer prints as written; the default one is translated', () => {
    expect(receiptText(render({ footer: 'See you tomorrow' }))).toContain('See you tomorrow');
  });
});
