-- Phase 19b: the accountant role (Bible 2.2 "accountant access, read-only"; ADR 0030). A CPA signs in
-- to the merchant app by phone and sees reports only; they never have a register PIN.
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'manager', 'cashier', 'accountant'));
ALTER TABLE memberships ADD CONSTRAINT memberships_accountant_no_pin CHECK (role <> 'accountant' OR pin_hash IS NULL);
