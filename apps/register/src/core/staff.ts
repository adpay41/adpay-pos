/**
 * Who is at the register (build plan P3 / F2). Sign-in is "tap your name, type your PIN", checked
 * **on the device** against the hash in the config snapshot, so it works through a 72-hour outage.
 *
 * - Every failure is an event; after PIN_MAX_FAILURES in a row a person is locked out on this
 *   register for PIN_LOCKOUT_MS. Lockout state lives in the local store, so a restart doesn't reset it.
 * - The signed-in person is stamped on every event (SaleSession.setActor) and survives a restart,
 *   like the open ticket does.
 * - An action the signed-in person lacks can be approved on the spot by anyone who holds it, with
 *   their own PIN: an `override.granted` event records both people.
 * - A merchant with no PINs set up yet runs without sign-in (and the UI says so), rather than
 *   locking the counter. Sales are then unattributed.
 */
import { PIN_LOCKOUT_MS, PIN_MAX_FAILURES, verifyPin, type Permission, type RegisterStaff, type RegisterStaffMember } from '@adpay/shared';
import type { SaleSession } from './session';
import type { EventStore } from './store';

const SIGNED_IN_KEY = 'staff_signed_in';
const FAILURES_KEY = 'staff_pin_failures';

interface FailureState {
  count: number;
  locked_until: number | null;
}

export class PinError extends Error {
  constructor(
    message: string,
    readonly locked: boolean,
  ) {
    super(message);
    this.name = 'PinError';
  }
}

export interface StaffState {
  /** False when the merchant has not set up any PINs: the register runs without sign-in. */
  required: boolean;
  member: RegisterStaffMember | null;
}

export class StaffGate {
  private staff: RegisterStaff = { members: [] };
  private current: RegisterStaffMember | null = null;
  private failures: Record<string, FailureState> = {};
  private listeners = new Set<(s: StaffState) => void>();

  constructor(
    private readonly store: EventStore,
    private readonly session: SaleSession,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Load the staff list and restore whoever was signed in before a restart. */
  async restore(staff: RegisterStaff | undefined): Promise<void> {
    this.failures = JSON.parse((await this.store.getMeta(FAILURES_KEY)) ?? '{}') as Record<string, FailureState>;
    this.staff = staff ?? { members: [] };
    const id = await this.store.getMeta(SIGNED_IN_KEY);
    this.current = this.staff.members.find((m) => m.user_id === id) ?? null;
    this.session.setActor(this.current?.user_id ?? null);
    this.notify();
  }

  /** A newer snapshot: permissions refresh; someone removed or disabled is signed out. */
  async update(staff: RegisterStaff | undefined): Promise<void> {
    this.staff = staff ?? { members: [] };
    if (this.current) {
      const fresh = this.staff.members.find((m) => m.user_id === this.current!.user_id) ?? null;
      if (!fresh) await this.signOut('manual');
      else this.current = fresh;
    }
    this.notify();
  }

  state(): StaffState {
    return { required: this.staff.members.length > 0, member: this.current };
  }

  members(): RegisterStaffMember[] {
    return this.staff.members;
  }

  subscribe(fn: (s: StaffState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  /** Milliseconds until this person may try again on this register, or 0. */
  lockedFor(userId: string): number {
    const until = this.failures[userId]?.locked_until ?? null;
    return until && until > this.now() ? until - this.now() : 0;
  }

  private async saveFailures() {
    await this.store.setMeta(FAILURES_KEY, JSON.stringify(this.failures));
  }

  /** Check a PIN for one person, recording failures and lockouts as events. */
  private async check(member: RegisterStaffMember, pin: string, purpose: 'sign_in' | 'override'): Promise<void> {
    const wait = this.lockedFor(member.user_id);
    if (wait > 0) throw new PinError(`${member.name} is locked out on this register for ${Math.ceil(wait / 60_000)} more min`, true);
    if (verifyPin(pin, member.pin_hash)) {
      if (this.failures[member.user_id]) {
        delete this.failures[member.user_id];
        await this.saveFailures();
      }
      return;
    }
    const prev = this.failures[member.user_id];
    const count = (prev && !prev.locked_until ? prev.count : 0) + 1;
    const locked = count >= PIN_MAX_FAILURES;
    this.failures[member.user_id] = { count: locked ? 0 : count, locked_until: locked ? this.now() + PIN_LOCKOUT_MS : null };
    await this.saveFailures();
    await this.session.recordStaff('staff.pin_failed', { user_id: member.user_id, purpose, failures: count, locked });
    throw new PinError(
      locked ? `Too many wrong PINs. ${member.name} is locked out on this register for 5 minutes.` : `Wrong PIN (${PIN_MAX_FAILURES - count} tries left)`,
      locked,
    );
  }

  async signIn(userId: string, pin: string): Promise<RegisterStaffMember> {
    const member = this.staff.members.find((m) => m.user_id === userId);
    if (!member) throw new PinError('That person can’t sign in here', false);
    await this.check(member, pin, 'sign_in');
    if (this.current && this.current.user_id !== userId) await this.signOut('switch');
    this.current = member;
    this.session.setActor(member.user_id);
    await this.store.setMeta(SIGNED_IN_KEY, member.user_id);
    await this.session.recordStaff('staff.signed_in', { user_id: member.user_id, method: 'pin' });
    this.notify();
    return member;
  }

  async signOut(reason: 'manual' | 'switch' | 'idle'): Promise<void> {
    const who = this.current;
    if (!who) return;
    await this.session.recordStaff('staff.signed_out', { user_id: who.user_id, reason });
    this.current = null;
    this.session.setActor(null);
    await this.store.setMeta(SIGNED_IN_KEY, null);
    this.notify();
  }

  /** May the signed-in person do this without an override? */
  can(permission: Permission): boolean {
    if (!this.state().required) return true;
    return !!this.current?.permissions.includes(permission);
  }

  /** People who could approve `permission` for someone else (holders, other than the signed-in person). */
  approvers(permission: Permission): RegisterStaffMember[] {
    return this.staff.members.filter((m) => m.permissions.includes(permission) && m.user_id !== this.current?.user_id);
  }

  /**
   * A manager override: `approverId` holds `permission` and proves it with their PIN. Records who
   * approved what for whom, then the caller performs the action (still as the signed-in cashier).
   */
  async override(permission: Permission, approverId: string, pin: string, saleId: string | null = null): Promise<void> {
    const approver = this.staff.members.find((m) => m.user_id === approverId);
    if (!approver || !approver.permissions.includes(permission)) throw new PinError(`${approver?.name ?? 'That person'} can’t approve this`, false);
    await this.check(approver, pin, 'override');
    await this.session.recordStaff(
      'override.granted',
      { action: permission, approver_user_id: approver.user_id, for_user_id: this.current?.user_id ?? null },
      saleId,
    );
  }
}
