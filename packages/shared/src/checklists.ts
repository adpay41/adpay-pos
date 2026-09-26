/**
 * Opening and closing checklists (Bible 2.8; P24c, ADR 0038). The owner writes the lists in the
 * merchant app; they reach the register in the config snapshot; the cashier ticks them off, with a
 * photo where the item asks for one (the slicer cleaned, the safe locked), and the register records
 * one `checklist.completed` event. What was and wasn't done is kept as it was ticked: an unticked
 * item is recorded as not done, never dropped.
 */
import { z } from 'zod';

export const CHECKLIST_KINDS = ['open', 'close'] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];
export const CHECKLIST_LABELS: Record<ChecklistKind, string> = { open: 'Opening checklist', close: 'Closing checklist' };
export const CHECKLIST_MAX_ITEMS = 20;

export const ChecklistItemInput = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().trim().min(2).max(80),
  /** The cashier is asked for a photo of it. */
  photo: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof ChecklistItemInput>;

const itemList = z
  .array(ChecklistItemInput)
  .max(CHECKLIST_MAX_ITEMS)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Each item once');

export const ChecklistsInput = z.strictObject({ open: itemList, close: itemList });
export type Checklists = z.infer<typeof ChecklistsInput>;

/** What a store gets before the owner writes their own (a c-store / deli starting point). */
export const DEFAULT_CHECKLISTS: Checklists = {
  open: [
    { id: 'open-alarm', label: 'Alarm off, lights and signs on', photo: false },
    { id: 'open-float', label: 'Drawer float counted', photo: false },
    { id: 'open-coolers', label: 'Cooler and freezer temperatures OK', photo: true },
    { id: 'open-coffee', label: 'Coffee and deli counter ready', photo: false },
    { id: 'open-dated', label: 'Pulled anything past its date', photo: false },
  ],
  close: [
    { id: 'close-slicer', label: 'Deli slicer cleaned', photo: true },
    { id: 'close-floors', label: 'Floors swept, trash out', photo: false },
    { id: 'close-drop', label: 'Cash dropped in the safe', photo: true },
    { id: 'close-doors', label: 'Back door locked', photo: false },
    { id: 'close-lights', label: 'Lights and signs off, alarm on', photo: false },
  ],
};

export function checklistsOf(raw: unknown): Checklists {
  const parsed = ChecklistsInput.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CHECKLISTS;
}

/** One ticked-off item as recorded in the event. */
export interface ChecklistResultItem {
  item_id: string;
  label: string;
  photo_required: boolean;
  done: boolean;
  photo_media_id: string | null;
}

export interface ChecklistSummary {
  done: number;
  total: number;
  /** Items that asked for a photo and have none. */
  missing_photos: number;
  complete: boolean;
}

export function checklistSummary(items: readonly ChecklistResultItem[]): ChecklistSummary {
  const done = items.filter((i) => i.done).length;
  const missing = items.filter((i) => i.photo_required && !i.photo_media_id).length;
  return { done, total: items.length, missing_photos: missing, complete: done === items.length && missing === 0 };
}
