/**
 * Finix adapter — the ONLY place in the codebase allowed to import or configure Finix (ADR 0003).
 *
 * Not built yet: it is sequencing step 6, after the PAX A35 arrives. Until then every method throws,
 * and the stub is the provider in every environment. When this is implemented, selecting it is
 * `PAYMENT_PROVIDER=finix` and nothing else changes.
 *
 * ADR 0006: the sandbox this will first talk to belongs to AmericanDream11 LLC. Treat every Finix id
 * it produces as disposable; nothing may assume one survives the migration to AD Pay's own account.
 */
import type {
  AuthorizeRequest,
  PaymentProvider,
  PaymentResult,
  TerminalChargeRequest,
  TerminalStatus,
} from '../provider';

export interface FinixConfig {
  env: string;
  baseUrl: string;
  applicationId: string;
  apiKey: string;
  apiSecret: string;
}

/** Reads FINIX_* from the environment. Nothing outside this folder does. */
export function finixConfigFromEnv(): FinixConfig {
  return {
    env: process.env.FINIX_ENV ?? 'sandbox',
    baseUrl: process.env.FINIX_BASE_URL ?? '',
    applicationId: process.env.FINIX_APPLICATION_ID ?? '',
    apiKey: process.env.FINIX_API_KEY ?? '',
    apiSecret: process.env.FINIX_API_SECRET ?? '',
  };
}

const NOT_YET = 'Finix adapter is sequencing step 6 (after the PAX A35 arrives); use PAYMENT_PROVIDER=stub';

export class FinixPaymentProvider implements PaymentProvider {
  readonly name = 'finix';

  constructor(private readonly config: FinixConfig) {
    if (!config.apiKey || !config.apiSecret || !config.applicationId) {
      throw new Error('PAYMENT_PROVIDER=finix but FINIX_API_KEY / FINIX_API_SECRET / FINIX_APPLICATION_ID are not set');
    }
  }

  authorize(_req: AuthorizeRequest): Promise<PaymentResult> {
    return Promise.reject(new Error(NOT_YET));
  }
  capture(_ref: string, _amount: number, _key: string): Promise<PaymentResult> {
    return Promise.reject(new Error(NOT_YET));
  }
  refund(_ref: string, _amount: number, _key: string): Promise<PaymentResult> {
    return Promise.reject(new Error(NOT_YET));
  }
  void(_ref: string, _key: string): Promise<PaymentResult> {
    return Promise.reject(new Error(NOT_YET));
  }
  terminalCharge(_req: TerminalChargeRequest): Promise<PaymentResult> {
    return Promise.reject(new Error(NOT_YET));
  }
  terminalStatus(_terminalId: string): Promise<TerminalStatus> {
    return Promise.reject(new Error(NOT_YET));
  }
}
