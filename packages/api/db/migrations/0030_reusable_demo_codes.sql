-- Demo setup codes (tester feedback): the codes `npm run dev` / `npm run logins` arm are reusable, so a
-- code already used by one tester still pairs for the next (pairing again moves the register to the new
-- device, as it always has). Install-kit codes stay single-use.
ALTER TABLE register_setup_codes ADD COLUMN reusable boolean NOT NULL DEFAULT false;
