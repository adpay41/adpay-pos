/**
 * Loyalty on the register (P19a, ADR 0029).
 *
 * - The customer's number becomes a keyed hash here, with the merchant's salt from the snapshot;
 *   only the hash and the last four digits go on the sale. Earning works offline (the server folds
 *   the sale later).
 * - The balance comes from the server; offline there is none, and no reward can be applied.
 * - An opt-in to texts is sent with the number as soon as possible; offline it waits in a small local
 *   outbox (the only place a number is kept on the register) and is removed once the server has it.
 */
import { customerRef, normalizeUsPhone, TEXT_CONSENT_VERSION, type LoyaltySettings, type LoyaltyStatus } from '@adpay/shared';
import type { EventStore } from './store';

const OUTBOX_KEY = 'loyalty_optin_outbox';

export interface LoyaltyTransport {
  status(ref: string): Promise<LoyaltyStatus & { enabled: boolean }>;
  optIn(body: { phone: string; customer_ref: string; consent_version: string }): Promise<unknown>;
  textReceipt(body: { sale_id: string; receipt_token: string; phone: string }): Promise<{ status: string; delivered: boolean; to: string }>;
}

export interface IdentifiedCustomer {
  ref: string;
  last4: string;
  e164: string;
}

export class LoyaltyClient {
  constructor(
    private readonly store: EventStore,
    private readonly transport: LoyaltyTransport,
    private readonly config: () => { settings: LoyaltySettings; salt: string } | undefined,
  ) {}

  settings(): LoyaltySettings | null {
    const c = this.config();
    return c?.settings.enabled ? c.settings : null;
  }

  /** A typed number → the ref the sale carries; null when it isn't a US mobile number. */
  identify(raw: string): IdentifiedCustomer | null {
    const c = this.config();
    const e164 = normalizeUsPhone(raw);
    if (!c || !e164) return null;
    return { ref: customerRef(c.salt, e164), last4: e164.slice(-4), e164 };
  }

  /** The customer's standing; null offline. */
  async status(ref: string): Promise<LoyaltyStatus | null> {
    try {
      return await this.transport.status(ref);
    } catch {
      return null;
    }
  }

  /** Record an opt-in to texts: now if online, else from the outbox on the next sync. */
  async optIn(c: IdentifiedCustomer): Promise<void> {
    const body = { phone: c.e164, customer_ref: c.ref, consent_version: TEXT_CONSENT_VERSION };
    try {
      await this.transport.optIn(body);
    } catch {
      const queued = await this.queued();
      await this.store.setMeta(OUTBOX_KEY, JSON.stringify([...queued.filter((q) => q.customer_ref !== c.ref), body]));
    }
  }

  /** Send queued opt-ins; a refusal (bad number) is dropped, a network error keeps it queued. */
  async flush(): Promise<void> {
    const queued = await this.queued();
    if (queued.length === 0) return;
    const keep: typeof queued = [];
    for (const body of queued) {
      try {
        await this.transport.optIn(body);
      } catch (e) {
        if (!(e as { status?: number }).status || (e as { status: number }).status >= 500) keep.push(body);
      }
    }
    await this.store.setMeta(OUTBOX_KEY, keep.length ? JSON.stringify(keep) : null);
  }

  async pending(): Promise<number> {
    return (await this.queued()).length;
  }

  /** "Text me my receipt": online only. */
  textReceipt(saleId: string, receiptToken: string, phone: string) {
    return this.transport.textReceipt({ sale_id: saleId, receipt_token: receiptToken, phone });
  }

  private async queued(): Promise<{ phone: string; customer_ref: string; consent_version: string }[]> {
    const raw = await this.store.getMeta(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as { phone: string; customer_ref: string; consent_version: string }[]) : [];
  }
}
