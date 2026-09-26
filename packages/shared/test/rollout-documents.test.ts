import { describe, expect, it } from 'vitest';
import { daysUntil, expiryStatus, resolveFlags, rolloutBucket, rolloutValue, sniffDocumentType, type FlagRollouts } from '../src';

const ids = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('staged rollouts', () => {
  it('buckets are fixed, per flag, and about 10% under 10', () => {
    expect(rolloutBucket('price_check', ids[1]!)).toBe(rolloutBucket('price_check', ids[1]!.toUpperCase()));
    const under = ids.filter((m) => rolloutBucket('price_check', m) < 10).length;
    expect(under).toBeGreaterThan(60);
    expect(under).toBeLessThan(140);
    const other = ids.filter((m) => rolloutBucket('hold_tickets', m) < 10);
    expect(other).not.toEqual(ids.filter((m) => rolloutBucket('price_check', m) < 10));
  });

  it('canary → 10% → all never turns a store off along the way', () => {
    const canary = [ids[0]!];
    for (const m of ids.slice(0, 200)) {
      const a = rolloutValue('price_check', { stage: 'canary', canary_merchant_ids: canary }, m)!;
      const b = rolloutValue('price_check', { stage: 'ten_percent', canary_merchant_ids: canary }, m)!;
      const c = rolloutValue('price_check', { stage: 'all', canary_merchant_ids: canary }, m)!;
      expect(!a || b).toBe(true);
      expect(!b || c).toBe(true);
    }
    expect(rolloutValue('price_check', { stage: 'canary', canary_merchant_ids: canary }, ids[0]!)).toBe(true);
    expect(rolloutValue('price_check', { stage: 'default', canary_merchant_ids: [] }, ids[0]!)).toBeNull();
  });

  it('the kill switch beats a merchant override; otherwise the override beats the rollout', () => {
    const killed: FlagRollouts = { price_check: { stage: 'killed', canary_merchant_ids: [] } };
    expect(resolveFlags({ price_check: true }, killed, ids[0]!).price_check).toBe(false);
    const canary: FlagRollouts = { price_check: { stage: 'canary', canary_merchant_ids: [ids[0]!] } };
    expect(resolveFlags({}, canary, ids[1]!).price_check).toBe(false);
    expect(resolveFlags({ price_check: true }, canary, ids[1]!).price_check).toBe(true);
    expect(resolveFlags({}, canary, ids[0]!).price_check).toBe(true);
    expect(resolveFlags({}).price_check).toBe(true);
  });
});

describe('documents', () => {
  it('expiry status by days left', () => {
    expect(daysUntil('2026-10-26', '2026-09-26')).toBe(30);
    expect(expiryStatus('2026-10-26', '2026-09-26')).toBe('soon');
    expect(expiryStatus('2026-10-27', '2026-09-26')).toBe('ok');
    expect(expiryStatus('2026-09-25', '2026-09-26')).toBe('expired');
    expect(expiryStatus('2026-09-26', '2026-09-26')).toBe('soon');
    expect(expiryStatus(null, '2026-09-26')).toBe('none');
  });

  it('recognises PDF, JPEG and PNG by their bytes', () => {
    expect(sniffDocumentType(new TextEncoder().encode('%PDF-1.4\n'))).toBe('application/pdf');
    expect(sniffDocumentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffDocumentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffDocumentType(new TextEncoder().encode('<html>'))).toBeNull();
  });
});
