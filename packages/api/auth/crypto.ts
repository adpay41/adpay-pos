/**
 * Credential primitives. Passwords use scrypt (built into Node, no native addon). Opaque tokens and
 * one-time codes are stored only as SHA-256 hashes — the database never holds a usable credential.
 */
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16_384, r: 8, p: 1 };
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Register credential: `dev_` + 256 random bits. The prefix lets auth route it without a DB hit. */
export function newDeviceToken(): { token: string; hash: string } {
  const token = `dev_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

// No 0/O/1/I/L — codes are read off a screen and typed by hand.
const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newSetupCode(): { code: string; hash: string } {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return { code, hash: hashSetupCode(code) };
}

export function hashSetupCode(code: string): string {
  return sha256(`setup:${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
}

export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(challengeId: string, code: string): string {
  return sha256(`otp:${challengeId}:${code}`);
}
