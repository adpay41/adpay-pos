/**
 * Cashier language (P18b): the committed key list matches every t('…') in the register, Spanish is
 * complete and keeps every placeholder, and a missing translation falls back to English.
 */
import { CASHIER_EN, CASHIER_ES, coverage, placeholdersMatch, translate, type CashierKey } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { collectKeys } from '../scripts/extract-i18n';

describe('cashier strings', () => {
  it('the shared list is exactly what the register source uses (run `pnpm --filter @adpay/register i18n:extract`)', () => {
    expect([...CASHIER_EN]).toEqual(collectKeys());
  });

  it('Spanish covers every cashier string and keeps its placeholders', () => {
    expect(coverage('es', undefined, 'cashier').missing).toEqual([]);
    for (const [key, text] of Object.entries(CASHIER_ES)) expect(placeholdersMatch(key as CashierKey, text!), key).toBe(true);
  });

  it('fills values and falls back to English for an untranslated language', () => {
    expect(translate('es', 'Paid {amount} by card' as CashierKey, { amount: '$4.00' })).not.toContain('{amount}');
    expect(translate('ko', 'Void ticket' as CashierKey)).toBe('Void ticket');
    expect(translate('es', 'Void ticket' as CashierKey)).not.toBe('Void ticket');
  });
});
