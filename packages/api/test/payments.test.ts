import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPaymentProvider } from '../payments';

const tenancy = {
  org_id: '00000000-0000-4000-8000-000000000001',
  merchant_id: '00000000-0000-4000-8000-000000000002',
  location_id: '00000000-0000-4000-8000-000000000003',
  register_id: '00000000-0000-4000-8000-000000000004',
};

describe('PaymentProvider', () => {
  it('stub approves terminal charges and is idempotent per key', async () => {
    const p = createPaymentProvider('stub');
    const req = { tenancy, terminal_id: 't1', amount_cents: 1491, idempotency_key: 'k1', sale_id: 's1' };
    const first = await p.terminalCharge(req);
    expect(first.status).toBe('approved');
    expect(first.card?.last4).toMatch(/^\d{4}$/);
    expect(await p.terminalCharge(req)).toEqual(first);
    await expect(p.terminalCharge({ ...req, idempotency_key: 'k2', amount_cents: 14.91 })).rejects.toThrow();
  });

  it('selecting finix is one config value, and fails loudly without credentials', () => {
    expect(() => createPaymentProvider('finix')).toThrow(/FINIX_API_KEY/);
    expect(() => createPaymentProvider('square')).toThrow(/Unknown PAYMENT_PROVIDER/);
  });

  it('nothing outside payments/finix references the Finix adapter except the registry', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.git', '.next', '.expo', 'dist', 'cdk.out'].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          const rel = relative(root, full).split(sep).join('/');
          if (rel.startsWith('packages/api/payments/finix/') || rel === 'packages/api/payments/index.ts') continue;
          if (rel === 'eslint.config.mjs' || rel.startsWith('packages/api/test/')) continue;
          const src = readFileSync(full, 'utf8');
          if (/from\s+['"][^'"]*finix[^'"]*['"]|require\(\s*['"][^'"]*finix/i.test(src)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
