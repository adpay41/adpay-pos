/**
 * P15 on the register: close by denomination (must add up), photo id and handover (the next
 * session starts with the counted cash); counterfeit bills logged; the time clock, offline and
 * across a restart.
 */
import { randomUUID } from 'node:crypto';
import { cents, foldShifts } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { DrawerManager } from '../src/core/drawer';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';
import { TimeClock } from '../src/core/timeclock';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const MARIA = '50000000-0000-4000-8000-000000000001';

async function setup(store = new MemoryEventStore()) {
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  session.setActor(MARIA);
  const drawer = new DrawerManager(store, session, randomUUID);
  await drawer.restore();
  return { store, session, drawer };
}

describe('drawer close (P15)', () => {
  it('a count by denomination must add up; a handover starts the next session with the counted float', async () => {
    const { drawer } = await setup();
    await drawer.start(cents(20_000));
    await expect(drawer.close(cents(20_000), { denominations: { '2000': 9 } })).rejects.toThrow(/add up/);

    const photo = randomUUID();
    const closed = await drawer.close(cents(20_000), { denominations: { '2000': 9, '1000': 2 }, photo_media_id: photo, handover: true });
    expect(closed).toMatchObject({ over_short_cents: 0, denominations: { '2000': 9, '1000': 2 }, photo_media_id: photo, handover: true });
    // The next shift's drawer is already started with what was counted: nothing recounted.
    expect(drawer.current()).toMatchObject({ float_cents: 20_000, expected_cents: 20_000 });
  });

  it('a refused counterfeit is logged on the open session and the drawer total is unchanged', async () => {
    const { drawer } = await setup();
    await drawer.start(cents(10_000));
    await drawer.flagCounterfeit(5_000, 'feels like paper');
    expect(drawer.current()).toMatchObject({ expected_cents: 10_000, counterfeits: [{ denomination_cents: 5_000, note: 'feels like paper' }] });
  });
});

describe('time clock (P15)', () => {
  it('clocks in and out as events, survives a restart, and folds into a shift', async () => {
    const store = new MemoryEventStore();
    const { session } = await setup(store);
    let now = new Date('2026-09-24T13:00:00Z');
    const clock = new TimeClock(store, session, () => now);
    await clock.restore();
    await clock.clockIn(MARIA);
    await clock.clockIn(MARIA); // already on: no second punch

    const again = new TimeClock(store, session, () => now);
    await again.restore();
    now = new Date('2026-09-24T21:30:00Z');
    expect(again.minutes(MARIA)).toBe(510);
    await again.clockOut(MARIA);
    expect(again.since(MARIA)).toBeNull();

    const punches = (await store.eventsSince(0)).filter((e) => e.type.startsWith('staff.clocked'));
    expect(punches.map((e) => e.type)).toEqual(['staff.clocked_in', 'staff.clocked_out']);
    expect(foldShifts(punches)).toHaveLength(1);
  });
});
