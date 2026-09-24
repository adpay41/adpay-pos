import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, PermissionOverridesSchema, can, hashPin, parseRegisterEvent, permissionsFor, pinProblem, verifyPin } from '../src';

describe('register PINs', () => {
  it('hashes with a random salt and verifies only the right PIN', () => {
    const a = hashPin('2580');
    const b = hashPin('2580');
    expect(a).not.toBe(b); // salted
    expect(a).toMatch(/^pbkdf2-sha256\$10000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(verifyPin('2580', a)).toBe(true);
    expect(verifyPin('2581', a)).toBe(false);
    expect(verifyPin('', a)).toBe(false);
  });

  it('refuses malformed or tampered hashes rather than accepting anything', () => {
    const h = hashPin('2580');
    expect(verifyPin('2580', h.replace('pbkdf2-sha256', 'md5'))).toBe(false);
    expect(verifyPin('2580', h.replace('$10000$', '$1$'))).toBe(false); // iterations too low to trust
    expect(verifyPin('2580', 'garbage')).toBe(false);
  });

  it('rejects guessable PINs', () => {
    for (const bad of ['1234', '4321', '0000', '99999', '123', '1234567', '12a4', '456789']) expect(pinProblem(bad), bad).not.toBeNull();
    for (const ok of ['2580', '1357', '2468', '9021', '135790']) expect(pinProblem(ok), ok).toBeNull();
    expect(() => hashPin('1111')).toThrow();
  });
});

describe('permissions', () => {
  it('owners hold everything; managers all but staff management; cashiers the basics', () => {
    expect(permissionsFor('owner')).toEqual(PERMISSION_KEYS);
    expect(permissionsFor('manager')).not.toContain('staff.manage');
    expect(permissionsFor('manager')).toContain('sale.refund');
    expect(permissionsFor('cashier')).toEqual(['ticket.void', 'cash.drop', 'item.create']);
  });

  it('merchant overrides add and remove, but never take anything from owners', () => {
    const o = PermissionOverridesSchema.parse({ cashier: { 'sale.refund': true, 'ticket.void': false }, manager: { 'sale.void': false } });
    expect(permissionsFor('cashier', o)).toEqual(['sale.refund', 'cash.drop', 'item.create']);
    expect(can('manager', 'sale.void', o)).toBe(false);
    expect(PermissionOverridesSchema.safeParse({ owner: { 'sale.void': false } }).success).toBe(false);
    expect(can('owner', 'sale.void', o)).toBe(true);
  });
});

describe('staff events', () => {
  const env = {
    event_id: '0f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11',
    schema_version: 1,
    device_seq: 1,
    occurred_at: '2026-09-24T12:00:00.000Z',
    org_id: '1f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11',
    merchant_id: '2f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11',
    location_id: '3f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11',
    register_id: '4f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11',
    trace_id: 't',
  };
  const user = '5f6e0a57-6a8e-4a26-9a57-1f4e4b1e6a11';

  it('stand alone without a sale, and carry the actor', () => {
    const e = parseRegisterEvent({ ...env, sale_id: null, actor_user_id: user, type: 'staff.signed_in', payload: { user_id: user, method: 'pin' } });
    expect(e.actor_user_id).toBe(user);
  });

  it('older events without an actor still parse (additive field)', () => {
    const e = parseRegisterEvent({ ...env, sale_id: null, type: 'drawer.opened', payload: { reason: 'manual', by_user_id: null } });
    expect(e.actor_user_id).toBeNull();
  });

  it('never carry a PIN: payloads are strict', () => {
    expect(() =>
      parseRegisterEvent({ ...env, sale_id: null, type: 'staff.pin_failed', payload: { user_id: user, purpose: 'sign_in', failures: 1, locked: false, pin: '2580' } }),
    ).toThrow();
  });
});
