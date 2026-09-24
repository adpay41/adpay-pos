import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashOtp, newOtpCode, verifyPassword } from '../auth/crypto';
import { signUserToken, type AdminPrincipal, type MerchantUserPrincipal } from '../auth/principal';
import type { AppDeps } from '../server';
import { audit } from '../services/audit';
import { deviceIdentity, pairRegister } from '../services/onboarding';
import { membershipsOf, normalizePhone, resolveMembership } from '../services/staff';
import { notFound, tooMany, unauthorized } from '../http/errors';

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_15_MIN = 5;

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  app.post('/auth/admin/login', async (request) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const { rows } = await db.query<{ user_id: string; password_hash: string | null }>(
      `SELECT user_id, password_hash FROM users WHERE kind = 'admin' AND lower(email) = lower($1) AND disabled_at IS NULL`,
      [body.email],
    );
    const user = rows[0];
    const ok = user?.password_hash ? await verifyPassword(body.password, user.password_hash) : false;
    await audit(db, {
      actor: user ? { kind: 'admin', user_id: user.user_id, role: 'platform_admin' } : null,
      action: ok ? 'admin.login' : 'admin.login_failed',
      target: body.email.toLowerCase(),
      trace_id: request.logContext.trace_id,
    });
    if (!user || !ok) throw unauthorized('Wrong email or password');
    const principal: AdminPrincipal = { kind: 'admin', user_id: user.user_id, role: 'platform_admin' };
    return { token: await signUserToken(principal, config.jwtSecret, config.jwtIssuer), principal };
  });

  app.post('/auth/merchant/otp/request', async (request) => {
    const body = z.object({ phone: z.string().min(7).max(20) }).parse(request.body);
    const phone = normalizePhone(body.phone);
    const { rows: recent } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM otp_challenges WHERE phone = $1 AND created_at > now() - interval '15 minutes'`,
      [phone],
    );
    if ((recent[0]?.n ?? 0) >= OTP_MAX_PER_15_MIN) throw tooMany('Too many codes requested; try again in a few minutes');

    const { rows: users } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE kind = 'merchant_user' AND phone = $1 AND disabled_at IS NULL`,
      [phone],
    );
    // Local dev (OTP_DELIVERY=log): one fixed, documented code so nobody has to hunt for it.
    // loadConfig refuses OTP_DELIVERY=log in production, so this can never ship as a real login.
    const code = config.otpDelivery === 'log' ? config.devOtpCode : newOtpCode();
    const { rows } = await db.query<{ challenge_id: string }>(
      `INSERT INTO otp_challenges (phone, code_hash, expires_at) VALUES ($1, '', now() + make_interval(mins => $2))
       RETURNING challenge_id`,
      [phone, OTP_TTL_MINUTES],
    );
    const challengeId = rows[0]!.challenge_id;
    // Unknown numbers get a challenge too (that can never verify), so the response does not reveal
    // which phone numbers have accounts.
    const hash = users[0] ? hashOtp(challengeId, code) : 'no-account';
    await db.query(`UPDATE otp_challenges SET code_hash = $2 WHERE challenge_id = $1`, [challengeId, hash]);

    const devCode = config.otpDelivery === 'log' && users[0] ? code : undefined;
    if (devCode) request.log.info({ phone_last4: phone.slice(-4), dev_otp: devCode }, 'dev OTP (OTP_DELIVERY=log; no SMS sent)');
    return { challenge_id: challengeId, expires_in_seconds: OTP_TTL_MINUTES * 60, ...(devCode ? { dev_code: devCode } : {}) };
  });

  app.post('/auth/merchant/otp/verify', async (request) => {
    const body = z.object({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    const principal = await db.tx(async (q) => {
      const { rows } = await q.query<{ phone: string; code_hash: string; attempts: number }>(
        `UPDATE otp_challenges SET attempts = attempts + 1
          WHERE challenge_id = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
          RETURNING phone, code_hash, attempts`,
        [body.challenge_id, OTP_MAX_ATTEMPTS],
      );
      const ch = rows[0];
      if (!ch || ch.code_hash !== hashOtp(body.challenge_id, body.code)) return null;
      await q.query(`UPDATE otp_challenges SET consumed_at = now() WHERE challenge_id = $1`, [body.challenge_id]);
      const { rows: users } = await q.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE kind = 'merchant_user' AND phone = $1 AND disabled_at IS NULL`,
        [ch.phone],
      );
      if (!users[0]) return null;
      // Sign in to the first store they work at; the app offers a switcher when there are more.
      const [first] = await membershipsOf(q, users[0].user_id);
      if (!first) return null;
      const m = await resolveMembership(q, users[0].user_id, first.merchant_id);
      return m ? ({ kind: 'merchant_user', user_id: users[0].user_id, merchant_id: first.merchant_id, ...m } as MerchantUserPrincipal) : null;
    });
    if (!principal) throw unauthorized('That code is wrong or has expired');
    return { token: await signUserToken(principal, config.jwtSecret, config.jwtIssuer), principal };
  });

  /** Every store this person works at (for the merchant app's store switcher, Bible L32). */
  app.get('/auth/merchant/memberships', async (request) => {
    const p = request.principal;
    if (p?.kind !== 'merchant_user') throw unauthorized();
    return { current: p.merchant_id, memberships: await membershipsOf(db, p.user_id) };
  });

  /** Switch to another store this person works at: a new token scoped to that merchant. */
  app.post('/auth/merchant/switch', async (request) => {
    const p = request.principal;
    if (p?.kind !== 'merchant_user') throw unauthorized();
    const { merchant_id } = z.object({ merchant_id: z.uuid() }).parse(request.body);
    const m = await resolveMembership(db, p.user_id, merchant_id);
    // Not a member there: 404, like any other cross-tenant id.
    if (!m) throw notFound('Store not found');
    const principal: MerchantUserPrincipal = { kind: 'merchant_user', user_id: p.user_id, merchant_id, ...m };
    return { token: await signUserToken(principal, config.jwtSecret, config.jwtIssuer), principal };
  });

  app.post('/auth/device/pair', async (request) => {
    const body = z.object({ setup_code: z.string().min(8).max(20) }).parse(request.body);
    const result = await pairRegister(db, body.setup_code, config.deviceTokenTtlDays);
    const { identity } = result;
    await audit(db, {
      actor: null,
      action: 'register.paired',
      tenancy: identity,
      target: identity.register_id,
      trace_id: request.logContext.trace_id,
    });
    request.log.info({ register_id: identity.register_id }, 'register paired');
    return result;
  });

  app.get('/auth/me', async (request) => {
    const p = request.principal;
    if (!p) throw unauthorized();
    if (p.kind === 'device') return { principal: p, identity: await deviceIdentity(db, p.register_id) };
    const { rows } = await db.query<{ name: string; email: string | null; phone: string | null; merchant_name: string | null }>(
      `SELECT u.name, u.email, u.phone, m.name AS merchant_name FROM users u
         LEFT JOIN merchants m ON m.merchant_id = $2 WHERE u.user_id = $1`,
      [p.user_id, p.kind === 'merchant_user' ? p.merchant_id : null],
    );
    return { principal: p, user: rows[0] ?? null };
  });
}
