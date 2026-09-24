/**
 * Staff routes (build plan P3), mounted like the catalog routes:
 *   /admin/merchants/:merchantId/…  — AD Pay staff, any merchant
 *   /merchant/…                     — the merchant's own staff; writes need `staff.manage`
 *                                     (except setting your own PIN)
 * PINs arrive here once, are hashed, and are never returned.
 */
import { PermissionOverridesSchema, PinSetInput, StaffCreateInput, StaffUpdateInput } from '@adpay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asAdmin, asMerchantUser, requireAdmin, requireMerchantUser } from '../http/auth-hooks';
import type { AppDeps } from '../server';
import {
  createStaff,
  listStaff,
  permissionOverrides,
  setPermissionOverrides,
  setPin,
  updateStaff,
  type StaffActor,
} from '../services/staff';

interface Scope {
  prefix: string;
  guard: typeof requireAdmin;
  resolve: (r: FastifyRequest) => { merchantId: string; actor: StaffActor };
}

const SCOPES: Scope[] = [
  {
    prefix: '/admin/merchants/:merchantId',
    guard: requireAdmin,
    resolve: (r) => ({ merchantId: z.object({ merchantId: z.uuid() }).parse(r.params).merchantId, actor: asAdmin(r) }),
  },
  {
    prefix: '/merchant',
    guard: requireMerchantUser,
    resolve: (r) => {
      const me = asMerchantUser(r);
      return { merchantId: me.merchant_id, actor: me };
    },
  },
];

export async function staffRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const UserParams = z.object({ userId: z.uuid() });
  for (const scope of SCOPES) {
    const p = scope.prefix;
    app.register(async (s) => {
      s.addHook('preHandler', scope.guard);

      s.get(`${p}/staff`, async (r) => {
        const { merchantId } = scope.resolve(r);
        return { staff: await listStaff(db, merchantId), overrides: await permissionOverrides(db, merchantId) };
      });

      s.post(`${p}/staff`, async (r, reply) => {
        const { merchantId, actor } = scope.resolve(r);
        reply.status(201);
        return createStaff(db, actor, merchantId, StaffCreateInput.parse(r.body), r.logContext.trace_id);
      });

      s.patch(`${p}/staff/:userId`, async (r) => {
        const { merchantId, actor } = scope.resolve(r);
        const { userId } = UserParams.parse(r.params);
        return updateStaff(db, actor, merchantId, userId, StaffUpdateInput.parse(r.body), r.logContext.trace_id);
      });

      s.put(`${p}/staff/:userId/pin`, async (r) => {
        const { merchantId, actor } = scope.resolve(r);
        const { userId } = UserParams.parse(r.params);
        return setPin(db, actor, merchantId, userId, PinSetInput.parse(r.body).pin, r.logContext.trace_id);
      });

      s.put(`${p}/permissions`, async (r) => {
        const { merchantId, actor } = scope.resolve(r);
        return setPermissionOverrides(db, actor, merchantId, PermissionOverridesSchema.parse(r.body), r.logContext.trace_id);
      });
    });
  }
}
