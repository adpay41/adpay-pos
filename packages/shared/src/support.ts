/**
 * Support operations (Bible 3.2 "the one-person-supports-200-stores system", 2.8 equipment tickets;
 * build plan P24a, ADR 0036): tickets with SLA timers, canned fixes that can press the remote-action
 * button for you, a runbook for every alert, and the hardware inventory with its RMA / swap workflow.
 */
import { z } from 'zod';
import type { AlertRule, RemoteActionKind } from './ops';

export const TICKET_STATUSES = ['open', 'pending', 'solved'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ['normal', 'urgent'] as const;
export const TICKET_CATEGORIES = ['general', 'hardware', 'payments', 'software'] as const;

/** First response due: urgent within 4 hours, normal within one business day (24 h). */
export const SLA_MINUTES: Record<(typeof TICKET_PRIORITIES)[number], number> = { urgent: 4 * 60, normal: 24 * 60 };

export const TicketInput = z.strictObject({
  merchant_id: z.uuid(),
  location_id: z.uuid().nullable().default(null),
  register_id: z.uuid().nullable().default(null),
  sale_id: z.uuid().nullable().default(null),
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().max(2000).default(''),
  category: z.enum(TICKET_CATEGORIES).default('general'),
  priority: z.enum(TICKET_PRIORITIES).default('normal'),
});
export type TicketInput = z.infer<typeof TicketInput>;

/** What a merchant sends from the app: an equipment problem or a request (Bible 2.8). */
export const MerchantTicketInput = z.strictObject({
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().max(2000).default(''),
  category: z.enum(['hardware', 'general']).default('hardware'),
  register_id: z.uuid().nullable().default(null),
});

export interface CannedFix {
  title: string;
  /** What support says to the store, step by step. */
  steps: string;
  /** The remote action it presses on the ticket's register, if one helps. */
  action: RemoteActionKind | null;
}

export const CANNED_FIXES = {
  printer_paper: { title: 'Printer out of paper', steps: 'Open the printer lid, drop in an 80 mm roll with the paper coming off the bottom, close it. We’ve sent a test page.', action: 'printer_test' },
  wifi_changed: { title: 'Wi-Fi changed', steps: 'On the register: Settings → Wi-Fi → pick the store network and type the new password. Sales made meanwhile are safe on the register; we’ve asked it to sync.', action: 'force_sync' },
  register_frozen: { title: 'Register frozen', steps: 'We’ve restarted the app remotely. The open ticket comes back as it was.', action: 'restart_app' },
  not_syncing: { title: 'Sales not reaching the office', steps: 'We’ve asked the register to sync now. If it stays offline, check the network cable or Wi-Fi.', action: 'force_sync' },
  price_not_updated: { title: 'Price change not on the register', steps: 'We’ve pushed the latest prices to the register; they show on the next sale.', action: 'push_config' },
  need_logs: { title: 'We need the register’s logs', steps: 'We’ve fetched the last 200 log lines from the register; no need to do anything.', action: 'upload_logs' },
  pin_locked: { title: 'Cashier locked out', steps: 'Five wrong PINs lock that person for 5 minutes. After that they can try again, or the owner can set a new PIN in the app (Staff).', action: null },
  card_machine: { title: 'Card machine not responding', steps: 'Check the card machine is on and on the store Wi-Fi. Take cash meanwhile; card sales retry safely.', action: null },
} as const satisfies Record<string, CannedFix>;
export type CannedFixKey = keyof typeof CANNED_FIXES;
export const CannedFixKeySchema = z.enum(Object.keys(CANNED_FIXES) as [CannedFixKey, ...CannedFixKey[]]);

/** One runbook per alert rule (Bible 3.2): what it means, what to check, and the button that fixes it. */
export const RUNBOOKS: Record<AlertRule, { text: string; action: RemoteActionKind | null }> = {
  register_offline: { text: 'No heartbeat for 5+ minutes. Sales are safe on the register (72 h offline). Call the store: is it powered, is the internet up? It clears itself when the register is back.', action: null },
  queue_stuck: { text: 'The register is online but its queue isn’t draining. Force a sync; if it stays stuck, fetch the logs and look for rejected events.', action: 'force_sync' },
  events_rejected: { text: 'The server refused some events. Fetch the logs and open the sale timeline; a rejected event means a bug to fix, not data to edit.', action: 'upload_logs' },
  pin_lockout: { text: 'Five wrong PINs on one register. Usually a new cashier; the lock clears in 5 minutes, or the owner sets a new PIN in the app.', action: null },
  hardware_error: { text: 'The printer, scanner or card machine reports a fault. Run a printer test; for the card machine, check it is on and on the network.', action: 'printer_test' },
  high_void_rate: { text: 'Unusually many voids today. Look at the cashier’s tickets in the timeline before calling: training need, or something to talk about.', action: null },
  drawer_short: { text: 'A drawer counted short beyond the store’s threshold. The count sheet photo and the cash movements are on the drawer session.', action: null },
  no_sale_spike: { text: 'The drawer opened without a sale many times. Check who and when on the drawer session.', action: null },
  large_refund: { text: 'A large refund or void. Open the sale timeline to see who approved it.', action: null },
  drawer_over: { text: 'Too much cash in one drawer: the register is already asking for a safe drop.', action: null },
  eod_missing: { text: 'End of day wasn’t closed. Remind the store: Count the drawer, then End of day on the register.', action: null },
  big_ticket: { text: 'A big sale went through. Nothing to fix; a heads-up for the owner.', action: null },
  slow_hour: { text: 'Sales well below the usual for this hour. Check the register is up; otherwise, a quiet hour.', action: null },
  late_first_sale: { text: 'No sale yet, well past the usual first sale. Is the store open? Is the register on?', action: 'force_sync' },
};

// --- Hardware inventory & RMA ----------------------------------------------------------------------

export const HARDWARE_KINDS = ['register', 'printer', 'scanner', 'terminal', 'drawer', 'customer_display', 'router'] as const;
export const HARDWARE_STATUSES = ['in_stock', 'installed', 'rma', 'retired'] as const;
export type HardwareStatus = (typeof HARDWARE_STATUSES)[number];

export const HardwareInput = z.strictObject({
  kind: z.enum(HARDWARE_KINDS),
  model: z.string().trim().min(1).max(60),
  serial: z.string().trim().min(3).max(60),
  warranty_until: z.iso.date().nullable().default(null),
  note: z.string().trim().max(300).nullable().default(null),
});
export type HardwareInput = z.infer<typeof HardwareInput>;

/** How long a ticket has until its first-response SLA (negative = overdue), in minutes. */
export function slaMinutesLeft(t: { created_at: string; first_response_at: string | null; priority: (typeof TICKET_PRIORITIES)[number] }, now: Date): number | null {
  if (t.first_response_at) return null;
  const due = Date.parse(t.created_at) + SLA_MINUTES[t.priority] * 60_000;
  return Math.floor((due - now.getTime()) / 60_000);
}
