import { describe, expect, it } from 'vitest';
import { checklistsOf, checklistSummary, ChecklistsInput, DEFAULT_CHECKLISTS } from '../src';

describe('checklists', () => {
  it('starter lists are valid and are what a store without its own gets', () => {
    expect(ChecklistsInput.safeParse(DEFAULT_CHECKLISTS).success).toBe(true);
    expect(checklistsOf(null)).toEqual(DEFAULT_CHECKLISTS);
    expect(checklistsOf({ open: [{ id: 'Bad Id', label: 'x' }], close: [] })).toEqual(DEFAULT_CHECKLISTS);
  });

  it('complete means every item ticked and every asked-for photo taken', () => {
    const item = (done: boolean, photo_required: boolean, photo_media_id: string | null) => ({ item_id: 'a', label: 'A', done, photo_required, photo_media_id });
    expect(checklistSummary([item(true, false, null), item(true, true, 'm')])).toEqual({ done: 2, total: 2, missing_photos: 0, complete: true });
    expect(checklistSummary([item(true, true, null)])).toMatchObject({ done: 1, missing_photos: 1, complete: false });
    expect(checklistSummary([item(false, false, null)])).toMatchObject({ done: 0, complete: false });
  });
});
