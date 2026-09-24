/**
 * Register peripherals behind one interface. On the T2s / Swan 2 these are implemented by the
 * Kotlin module (80mm printer, RJ12 drawer kick) — a later part of step 2 that needs the device.
 * In the browser, the "printer" is an on-screen preview and the drawer kick is logged.
 *
 * Printing and drawer kicks are recorded as events by the session *after* they happen, so the ticket
 * timeline in admin shows what the hardware actually did.
 */
import type { HardwareSlot, HardwareSlotName, ReceiptLine } from '@adpay/shared';

export interface Hardware {
  readonly kind: 'web-preview' | 'android';
  printReceipt(lines: readonly ReceiptLine[]): Promise<void>;
  kickDrawer(): Promise<void>;
  /** Health per slot for the heartbeat and the sync pill (P4). The Kotlin module reports real states. */
  health(): Record<HardwareSlotName, HardwareSlot>;
}

/** Browser build: everything is an on-screen stand-in; no terminal until P9 (stub) / P-HW (PAX). */
export const PREVIEW_HEALTH: Record<HardwareSlotName, HardwareSlot> = {
  printer: { state: 'preview', detail: 'on-screen receipt preview' },
  drawer: { state: 'preview', detail: 'on-screen notice' },
  scanner: { state: 'preview', detail: 'keyboard-wedge in browser' },
  terminal: { state: 'not_present', detail: null },
  customer_display: { state: 'preview', detail: 'second browser window' },
};

export class WebPreviewHardware implements Hardware {
  readonly kind = 'web-preview' as const;
  constructor(
    private readonly onPrint: (lines: readonly ReceiptLine[]) => void,
    private readonly onDrawer: () => void,
  ) {}
  async printReceipt(lines: readonly ReceiptLine[]) {
    this.onPrint(lines);
  }
  async kickDrawer() {
    this.onDrawer();
  }
  health() {
    return PREVIEW_HEALTH;
  }
}
