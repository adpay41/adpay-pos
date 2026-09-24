/**
 * PaymentProvider — the only payment surface the rest of the codebase sees (ADR 0003).
 *
 * Card data never touches our stack (CLAUDE.md rule 3): `terminalCharge` asks the processor's cloud
 * API to drive the PAX A35, and all we ever receive back is an opaque reference, brand, last four
 * and the approval result. None of these types has a field that could hold a PAN, track data or CVV.
 *
 * Amounts are integer cents. Processor vocabulary is translated into these types inside each
 * adapter and never leaks out.
 */
import type { TenantIds } from '@adpay/shared';

export type PaymentStatus = 'approved' | 'declined' | 'pending' | 'error';

export interface CardSummary {
  brand: string | null;
  last4: string | null;
}

export interface PaymentResult {
  status: PaymentStatus;
  /** Processor's opaque id for this transfer/authorization. */
  provider_ref: string;
  approval_code: string | null;
  amount_cents: number;
  card: CardSummary | null;
  /** Human-readable reason on decline/error, safe to show a cashier. */
  message: string | null;
}

export interface TerminalChargeRequest {
  tenancy: TenantIds;
  /** Our id for the card terminal paired to this register. */
  terminal_id: string;
  amount_cents: number;
  /** The tender_id minted on the register; replaying the same key never double-charges. */
  idempotency_key: string;
  sale_id: string;
}

export interface TerminalStatus {
  terminal_id: string;
  reachable: boolean;
  state: 'idle' | 'busy' | 'offline' | 'unknown';
  checked_at: string;
}

export interface AuthorizeRequest {
  tenancy: TenantIds;
  amount_cents: number;
  /** A processor-issued payment token (never a card number). */
  payment_token: string;
  idempotency_key: string;
}

export interface PaymentProvider {
  readonly name: string;
  authorize(req: AuthorizeRequest): Promise<PaymentResult>;
  capture(provider_ref: string, amount_cents: number, idempotency_key: string): Promise<PaymentResult>;
  refund(provider_ref: string, amount_cents: number, idempotency_key: string): Promise<PaymentResult>;
  void(provider_ref: string, idempotency_key: string): Promise<PaymentResult>;
  terminalCharge(req: TerminalChargeRequest): Promise<PaymentResult>;
  terminalStatus(terminal_id: string): Promise<TerminalStatus>;
}

export function assertCents(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`amount_cents must be a non-negative integer`);
}
