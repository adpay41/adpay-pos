/**
 * Stub provider: approves everything, deterministically, with no network. It is the provider in
 * every environment until the Finix adapter lands (sequencing step 6). Replaying an idempotency key
 * returns the original result, which is the behaviour the real adapter must match.
 */
import { createHash } from 'node:crypto';
import {
  assertCents,
  type AuthorizeRequest,
  type PaymentProvider,
  type PaymentResult,
  type TerminalChargeRequest,
  type TerminalStatus,
} from '../provider';

const BRANDS = ['visa', 'mastercard', 'discover', 'amex'] as const;

function refFor(key: string): string {
  return `stub_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

function fakeCard(key: string) {
  const h = createHash('sha256').update(`card:${key}`).digest();
  return { brand: BRANDS[h[0]! % BRANDS.length]!, last4: String(h.readUInt16BE(1) % 10_000).padStart(4, '0') };
}

export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  private readonly results = new Map<string, PaymentResult>();

  private once(key: string, make: () => PaymentResult): PaymentResult {
    const existing = this.results.get(key);
    if (existing) return existing;
    const result = make();
    this.results.set(key, result);
    return result;
  }

  private approved(key: string, amount: number, withCard: boolean): PaymentResult {
    assertCents(amount);
    return {
      status: 'approved',
      provider_ref: refFor(key),
      approval_code: refFor(`auth:${key}`).slice(-6).toUpperCase(),
      amount_cents: amount,
      card: withCard ? fakeCard(key) : null,
      message: null,
    };
  }

  async authorize(req: AuthorizeRequest): Promise<PaymentResult> {
    return this.once(`authorize:${req.idempotency_key}`, () => this.approved(req.idempotency_key, req.amount_cents, true));
  }

  async capture(_ref: string, amount: number, key: string): Promise<PaymentResult> {
    return this.once(`capture:${key}`, () => this.approved(key, amount, false));
  }

  async refund(_ref: string, amount: number, key: string): Promise<PaymentResult> {
    return this.once(`refund:${key}`, () => this.approved(key, amount, false));
  }

  async void(_ref: string, key: string): Promise<PaymentResult> {
    return this.once(`void:${key}`, () => this.approved(key, 0, false));
  }

  async terminalCharge(req: TerminalChargeRequest): Promise<PaymentResult> {
    return this.once(`terminal:${req.idempotency_key}`, () => this.approved(req.idempotency_key, req.amount_cents, true));
  }

  async terminalStatus(terminal_id: string): Promise<TerminalStatus> {
    return { terminal_id, reachable: true, state: 'idle', checked_at: new Date().toISOString() };
  }
}
