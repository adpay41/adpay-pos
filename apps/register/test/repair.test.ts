import { describe, expect, it } from 'vitest';
import { seedEndOfDay } from '../src/core/eod';
import { MemoryEventStore, SEQ_FLOOR_KEY } from '../src/core/store';

describe('a register paired onto existing history', () => {
  it('numbers its events after the server’s highest seq', async () => {
    const store = new MemoryEventStore();
    expect(await store.nextSeq()).toBe(0);
    await store.setMeta(SEQ_FLOOR_KEY, '68');
    expect(await store.nextSeq()).toBe(69);
  });

  it('carries on the register’s Z numbering, covering only its own events', async () => {
    const store = new MemoryEventStore();
    await seedEndOfDay(store, 3, 68);
    expect(JSON.parse((await store.getMeta('eod'))!)).toEqual({ z_number: 4, from_seq: 69, last_closed_at: null });
    // Never over a device's own Z history, and nothing to seed for a register with no Z yet.
    await seedEndOfDay(store, 9, 100);
    expect(JSON.parse((await store.getMeta('eod'))!).z_number).toBe(4);
    const fresh = new MemoryEventStore();
    await seedEndOfDay(fresh, 0, 10);
    expect(await fresh.getMeta('eod')).toBeNull();
  });
});
