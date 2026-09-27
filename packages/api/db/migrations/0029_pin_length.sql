-- PIN length (tester feedback): the register's keypad stops at the person's PIN length and signs in on the
-- last digit. Recorded when a PIN is set; null for PINs set before this (the keypad then takes 4 to 6).
ALTER TABLE memberships ADD COLUMN pin_length smallint CHECK (pin_length BETWEEN 4 AND 6);
