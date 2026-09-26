/**
 * Staged rollouts and the kill switch (Bible 3.2; P24b, ADR 0037).
 *
 * A flag's platform-wide stage (canary stores → 10% → all, or killed) sits over the per-merchant
 * overrides of ADR 0021; `resolveFlags` (shared) applies it. Every change is a new row in
 * `flag_rollouts` and bumps every merchant's catalog version, so registers pick it up over /ws within
 * seconds, and the apps on their next load. A build of the register app itself (OTA) is not in scope:
 * that waits on the MDM / own-OTA decision.
 */
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,
  resolveFlags,
  type FeatureFlag,
  type FlagRolloutInput,
  type FlagRollouts,
  type RolloutStage,
} from '@adpay/shared';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest } from '../http/errors';
import { audit } from './audit';

interface RolloutRow {
  flag: string;
  stage: RolloutStage;
  canary_merchant_ids: string[];
  reason: string;
  set_by_name: string | null;
  created_at: Date;
}

/** The current stage of every flag that has one. */
export async function currentRollouts(q: Queryable): Promise<FlagRollouts> {
  const { rows } = await q.query<{ flag: string; stage: RolloutStage; canary_merchant_ids: string[] }>(
    'SELECT DISTINCT ON (flag) flag, stage, canary_merchant_ids FROM flag_rollouts ORDER BY flag, created_at DESC',
  );
  const out: FlagRollouts = {};
  for (const r of rows) if ((FEATURE_FLAG_KEYS as string[]).includes(r.flag)) out[r.flag as FeatureFlag] = { stage: r.stage, canary_merchant_ids: r.canary_merchant_ids };
  return out;
}

export interface RolloutOverview {
  flag: FeatureFlag;
  label: string;
  where: string;
  default: boolean;
  stage: RolloutStage;
  canary: { merchant_id: string; name: string }[];
  /** Stores the flag is on for right now (rollout and overrides applied), of all stores. */
  on: number;
  stores: number;
  /** Stores with their own override for this flag (support switched it for them). */
  overridden: number;
  history: { stage: RolloutStage; reason: string; set_by_name: string | null; at: string }[];
}

export async function rolloutOverview(q: Queryable): Promise<RolloutOverview[]> {
  const rollouts = await currentRollouts(q);
  const { rows: merchants } = await q.query<{ merchant_id: string; name: string; feature_flags: Record<string, unknown> }>('SELECT merchant_id, name, feature_flags FROM merchants ORDER BY name');
  const names = new Map(merchants.map((m) => [m.merchant_id, m.name]));
  const { rows: hist } = await q.query<RolloutRow>(
    `SELECT r.flag, r.stage, r.canary_merchant_ids, r.reason, u.name AS set_by_name, r.created_at
       FROM flag_rollouts r LEFT JOIN users u ON u.user_id = r.set_by
      ORDER BY r.created_at DESC LIMIT 500`,
  );
  const resolved = merchants.map((m) => resolveFlags(m.feature_flags, rollouts, m.merchant_id));
  return FEATURE_FLAG_KEYS.map((flag) => {
    const r = rollouts[flag];
    return {
      flag,
      label: FEATURE_FLAGS[flag].label,
      where: FEATURE_FLAGS[flag].where,
      default: FEATURE_FLAGS[flag].default,
      stage: r?.stage ?? 'default',
      canary: (r?.canary_merchant_ids ?? []).map((id) => ({ merchant_id: id, name: names.get(id) ?? id })),
      on: resolved.filter((f) => f[flag]).length,
      stores: merchants.length,
      overridden: merchants.filter((m) => typeof m.feature_flags?.[flag] === 'boolean').length,
      history: hist
        .filter((h) => h.flag === flag)
        .slice(0, 10)
        .map((h) => ({ stage: h.stage, reason: h.reason, set_by_name: h.set_by_name, at: h.created_at.toISOString() })),
    };
  });
}

export async function setRollout(db: Db, actor: AdminPrincipal, flag: FeatureFlag, input: FlagRolloutInput, traceId: string): Promise<RolloutOverview> {
  if (!(FEATURE_FLAG_KEYS as string[]).includes(flag)) throw badRequest('Unknown flag');
  const canary = [...new Set(input.canary_merchant_ids)];
  if (input.stage === 'canary' && !canary.length) throw badRequest('Pick at least one canary store');
  await db.tx(async (q) => {
    if (canary.length) {
      const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM merchants WHERE merchant_id = ANY($1::uuid[])', [canary]);
      if (rows[0]!.n !== canary.length) throw badRequest('A canary store was not found');
    }
    const before = (await currentRollouts(q))[flag] ?? { stage: 'default', canary_merchant_ids: [] };
    await q.query('INSERT INTO flag_rollouts (flag, stage, canary_merchant_ids, reason, set_by, trace_id) VALUES ($1, $2, $3, $4, $5, $6)', [
      flag,
      input.stage,
      canary,
      input.reason,
      actor.user_id,
      traceId,
    ]);
    // Every store's snapshot changes: bump them all, so registers refresh now (the /ws nudge).
    await q.query('UPDATE merchants SET catalog_version = catalog_version + 1');
    await audit(q, {
      actor,
      action: input.stage === 'killed' ? 'flag.killed' : 'flag.rollout_set',
      target: flag,
      details: { from: before, to: { stage: input.stage, canary_merchant_ids: canary }, reason: input.reason },
      trace_id: traceId,
    });
  });
  return (await rolloutOverview(db)).find((o) => o.flag === flag)!;
}
