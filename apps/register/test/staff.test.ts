/**
 * Register sign-in, lockout and manager override (P3): all offline, against the local store only.
 */
import { randomUUID } from 'node:crypto';
import { PIN_LOCKOUT_MS, PIN_MAX_FAILURES, hashPin, permissionsFor, type CatalogItem, type RegisterStaff } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { PinError, StaffGate } from '../src/core/staff';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const MARIA = randomUUID();
const LUIS = randomUUID();
const NADIA = randomUUID();

// Hashing is the slow part; do it once.
const STAFF: RegisterStaff = {
  members: [
    { user_id: NADIA, name: 'Nadia Haddad', role: 'owner', pin_hash: hashPin('2580'), permissions: permissionsFor('owner') },
    { user_id: LUIS, name: 'Luis Ortega', role: 'manager', pin_hash: hashPin('1357'), permissions: permissionsFor('manager') },
    { user_id: MARIA, name: 'Maria Santos', role: 'cashier', pin_hash: hashPin('2468'), permissions: permissionsFor('cashier') },
  ],
};

const COFFEE: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Coffee', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 275,
  card_price_cents: 286, card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0,
  min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};

async function setup(staff: RegisterStaff | undefined = STAFF, store = new MemoryEventStore()) {
  let clock = Date.parse('2026-09-24T12:00:00Z');
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID, now: () => new Date(clock) });
  await session.restore();
  const gate = new StaffGate(store, session, () => clock);
  await gate.restore(staff);
  return { store, session, gate, advance: (ms: number) => (clock += ms) };
}

const allEvents = async (store: MemoryEventStore) => store.unacked(10_000);

describe('sign-in', () => {
  it('is required once any PINs exist; the right PIN signs in and every later event carries the cashier', async () => {
    const { store, session, gate } = await setup();
    expect(gate.state()).toMatchObject({ required: true, member: null });
    await gate.signIn(MARIA, '2468');
    expect(gate.state().member?.name).toBe('Maria Santos');

    await session.addItem(COFFEE);
    const events = await allEvents(store);
    expect(events.map((e) => e.type)).toEqual(['staff.signed_in', 'sale.opened', 'sale.line_added']);
    expect(events.every((e) => e.actor_user_id === MARIA)).toBe(true);
    const opened = events.find((e) => e.type === 'sale.opened')!;
    expect(opened.type === 'sale.opened' && opened.payload.cashier_user_id).toBe(MARIA);
  });

  it('a wrong PIN is refused and recorded, and the PIN itself is never in any event', async () => {
    const { store, gate } = await setup();
    await expect(gate.signIn(MARIA, '9999')).rejects.toBeInstanceOf(PinError);
    expect(gate.state().member).toBeNull();
    const events = await allEvents(store);
    expect(events.map((e) => e.type)).toEqual(['staff.pin_failed']);
    expect(JSON.stringify(events)).not.toContain('9999');
  });

  it(`locks a person out on this register after ${PIN_MAX_FAILURES} misses, even across a restart, then lets them back`, async () => {
    const store = new MemoryEventStore();
    const first = await setup(STAFF, store);
    for (let i = 1; i < PIN_MAX_FAILURES; i++) await expect(first.gate.signIn(MARIA, '0001')).rejects.toThrow(/tries left/);
    await expect(first.gate.signIn(MARIA, '0001')).rejects.toThrow(/locked out/);
    const failed = (await allEvents(store)).filter((e) => e.type === 'staff.pin_failed');
    expect(failed.at(-1)!.type === 'staff.pin_failed' && failed.at(-1)!.payload.locked).toBe(true);

    // Restart the app: still locked, even with the right PIN. Others are unaffected.
    const second = new StaffGate(store, first.session, () => Date.parse('2026-09-24T12:01:00Z'));
    await second.restore(STAFF);
    await expect(second.signIn(MARIA, '2468')).rejects.toThrow(/locked out/);
    await second.signIn(LUIS, '1357');

    const later = new StaffGate(store, first.session, () => Date.parse('2026-09-24T12:00:00Z') + PIN_LOCKOUT_MS + 1);
    await later.restore(STAFF);
    await later.signIn(MARIA, '2468');
    expect(later.state().member?.user_id).toBe(MARIA);
  });

  it('stays signed in across a restart (like the open ticket), and signs out on request', async () => {
    const store = new MemoryEventStore();
    const a = await setup(STAFF, store);
    await a.gate.signIn(MARIA, '2468');
    const b = await setup(STAFF, store);
    expect(b.gate.state().member?.user_id).toBe(MARIA);
    await b.gate.signOut('manual');
    expect(b.gate.state().member).toBeNull();
    expect((await allEvents(store)).at(-1)!.type).toBe('staff.signed_out');
  });

  it('someone removed from staff is signed out when the new snapshot arrives', async () => {
    const { gate } = await setup();
    await gate.signIn(MARIA, '2468');
    await gate.update({ members: STAFF.members.filter((m) => m.user_id !== MARIA) });
    expect(gate.state().member).toBeNull();
  });

  it('a store with no PINs set up runs without sign-in instead of locking the counter', async () => {
    const { gate, session, store } = await setup({ members: [] });
    expect(gate.state().required).toBe(false);
    expect(gate.can('sale.refund')).toBe(true);
    await session.addItem(COFFEE);
    expect((await allEvents(store)).every((e) => e.actor_user_id === null)).toBe(true);
  });
});

describe('manager override', () => {
  it('a cashier lacking a permission gets it approved by a manager PIN; both people are recorded', async () => {
    const { store, gate, session } = await setup();
    await gate.signIn(MARIA, '2468');
    expect(gate.can('drawer.no_sale')).toBe(false);
    expect(gate.approvers('drawer.no_sale').map((m) => m.name)).toEqual(['Nadia Haddad', 'Luis Ortega']);

    await expect(gate.override('drawer.no_sale', LUIS, '0000')).rejects.toBeInstanceOf(PinError);
    await gate.override('drawer.no_sale', LUIS, '1357');
    await session.recordDrawer('manual', null);

    const events = await allEvents(store);
    const granted = events.find((e) => e.type === 'override.granted')!;
    expect(granted.type === 'override.granted' && granted.payload).toEqual({ action: 'drawer.no_sale', approver_user_id: LUIS, for_user_id: MARIA });
    // The cashier stays the actor; the drawer event says who was at the register.
    expect(events.at(-1)).toMatchObject({ type: 'drawer.opened', actor_user_id: MARIA });
  });

  it('refuses an approver who does not hold the permission', async () => {
    const { gate } = await setup();
    await gate.signIn(LUIS, '1357');
    await expect(gate.override('staff.manage', MARIA, '2468')).rejects.toThrow(/can’t approve/);
  });
});
