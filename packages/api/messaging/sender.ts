/**
 * Outbound messages: SMS and email (P18b, ADR 0028). Everything that sends a message to a person
 * depends on `MessageSender` only, like payments depend on `PaymentProvider`.
 *
 * v1 has one implementation, `log`: the message is recorded in `outbound_messages` (by the caller)
 * and written to the API log with the recipient masked. Nothing leaves the building. A real provider
 * (Twilio for SMS, SES for email) needs an account and TCPA review; it is one new class here and
 * one config value (MESSAGE_PROVIDER), no other file changes.
 */
import type pino from 'pino';

export type Channel = 'sms' | 'email';

export interface OutboundMessage {
  channel: Channel;
  /** E.164-style US phone ("+12015550100") or an email address. */
  to: string;
  subject: string | null;
  body: string;
}

export interface SendResult {
  /** `logged`: accepted by the local sender, not delivered to anyone. */
  status: 'sent' | 'logged' | 'failed';
  provider_ref: string | null;
  error: string | null;
}

export interface MessageSender {
  readonly name: string;
  /** False when this sender records messages but never delivers them (the UI says so). */
  readonly delivers: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
}

export const maskRecipient = (to: string) =>
  to.includes('@') ? to.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : `•••${to.replace(/\D/g, '').slice(-4)}`;

export class LogSender implements MessageSender {
  readonly name = 'log';
  readonly delivers = false;
  constructor(private readonly logger: pino.Logger) {}
  async send(m: OutboundMessage): Promise<SendResult> {
    this.logger.info({ channel: m.channel, to: maskRecipient(m.to), subject: m.subject, chars: m.body.length }, 'message recorded (MESSAGE_PROVIDER=log; not delivered)');
    return { status: 'logged', provider_ref: null, error: null };
  }
}

export function createMessageSender(provider: string, logger: pino.Logger): MessageSender {
  if (provider === 'log') return new LogSender(logger);
  throw new Error(`MESSAGE_PROVIDER=${provider} is not built: SMS needs a Twilio account, email an SES account (build plan, deferred)`);
}
