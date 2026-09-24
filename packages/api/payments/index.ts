/**
 * The single switch between payment adapters: PAYMENT_PROVIDER=stub|finix. This file is the only
 * one outside payments/finix/ permitted to reference the Finix adapter (enforced by ESLint).
 */
import { FinixPaymentProvider, finixConfigFromEnv } from './finix/finix-provider';
import type { PaymentProvider } from './provider';
import { StubPaymentProvider } from './stub/stub-provider';

export type { PaymentProvider, PaymentResult, TerminalChargeRequest, TerminalStatus } from './provider';

export function createPaymentProvider(name: string): PaymentProvider {
  switch (name) {
    case 'stub':
      return new StubPaymentProvider();
    case 'finix':
      return new FinixPaymentProvider(finixConfigFromEnv());
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${name}" (expected stub or finix)`);
  }
}
