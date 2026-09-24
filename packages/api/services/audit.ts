import type { TenantContext } from '@adpay/shared';
import { EMPTY_TENANT_CONTEXT } from '@adpay/shared';
import type { Principal } from '../auth/principal';
import type { Queryable } from '../db/db';

export interface AuditEntry {
  actor: Principal | null;
  action: string;
  tenancy?: Partial<TenantContext>;
  target?: string | null;
  details?: Record<string, unknown>;
  trace_id: string;
}

/** Append-only record of every admin action (and other security-relevant events). */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  const t = { ...EMPTY_TENANT_CONTEXT, ...e.tenancy };
  const actorId = e.actor && e.actor.kind !== 'device' ? e.actor.user_id : null;
  await q.query(
    `INSERT INTO audit_log (actor_user_id, actor_kind, action, org_id, merchant_id, location_id, register_id, target, details, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actorId,
      e.actor?.kind ?? 'anonymous',
      e.action,
      t.org_id,
      t.merchant_id,
      t.location_id,
      t.register_id,
      e.target ?? null,
      JSON.stringify(e.details ?? {}),
      e.trace_id,
    ],
  );
}
