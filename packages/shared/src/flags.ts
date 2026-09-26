/**
 * Feature flags per merchant (build plan P12b, Bible 3.4 L52). ADR 0021.
 *
 * A flag switches a built feature on or off for one merchant, with no new build: the register and
 * the apps read the resolved set from the config snapshot. Every flag has a default, so a merchant
 * with no overrides gets the product as designed. Vertical packs (`enabled_packs`) are the other
 * half of per-merchant configuration; see `packs.ts`.
 */
import { z } from 'zod';

export const FEATURE_FLAGS = {
  card_payments: { label: 'Card payments at the register', where: 'register', default: true },
  register_item_create: { label: 'Add an unknown barcode as a new item at the register', where: 'register', default: true },
  price_check: { label: 'Price check mode', where: 'register', default: true },
  hold_tickets: { label: 'Hold and recall tickets', where: 'register', default: true },
  support_chat: { label: 'Support chat in the merchant app', where: 'apps', default: true },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];
export type FeatureFlags = Record<FeatureFlag, boolean>;

/** Overrides only: a flag not listed keeps its default. */
export const FeatureFlagOverridesInput = z.partialRecord(z.enum(FEATURE_FLAG_KEYS as [FeatureFlag, ...FeatureFlag[]]), z.boolean());
export type FeatureFlagOverrides = z.infer<typeof FeatureFlagOverridesInput>;

// ───────────────────────────────────────────────────────────── staged rollouts (P24b) ──

/**
 * Platform-wide stage of a flag (Bible 3.2): `default` = the code default (no rollout), then canary
 * stores → 10% of stores → all. `killed` is the kill switch: off everywhere, over every merchant
 * override, until someone moves it back.
 */
export const ROLLOUT_STAGES = ['default', 'canary', 'ten_percent', 'all', 'killed'] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];
export const ROLLOUT_STAGE_LABELS: Record<RolloutStage, string> = {
  default: 'Code default',
  canary: 'Canary stores',
  ten_percent: 'Canary + 10% of stores',
  all: 'All stores',
  killed: 'Killed (off everywhere)',
};
export const ROLLOUT_PERCENT = 10;

export const FlagRolloutInput = z.strictObject({
  stage: z.enum(ROLLOUT_STAGES),
  canary_merchant_ids: z.array(z.uuid()).max(50).default([]),
  reason: z.string().trim().min(3).max(300),
});
export type FlagRolloutInput = z.infer<typeof FlagRolloutInput>;

export interface FlagRollout {
  stage: RolloutStage;
  canary_merchant_ids: string[];
}
export type FlagRollouts = Partial<Record<FeatureFlag, FlagRollout>>;

/**
 * A store's fixed bucket 0–99 for a flag (FNV-1a over flag + merchant id). Fixed, so moving from 10%
 * to all never turns a store off and on again; per flag, so the same stores aren't first every time.
 */
export function rolloutBucket(flag: string, merchantId: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${flag}:${merchantId.toLowerCase()}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

/** The rollout's answer for one merchant, or null when the flag isn't being rolled out. */
export function rolloutValue(flag: FeatureFlag, r: FlagRollout | undefined, merchantId: string | null): boolean | null {
  if (!r || r.stage === 'default') return null;
  if (r.stage === 'killed') return false;
  if (r.stage === 'all') return true;
  if (!merchantId) return false;
  if (r.canary_merchant_ids.includes(merchantId)) return true;
  return r.stage === 'ten_percent' && rolloutBucket(flag, merchantId) < ROLLOUT_PERCENT;
}

/**
 * The flags a merchant runs with. Order: the kill switch beats everything; then the merchant's own
 * override (support switched it for that store); then the rollout stage; then the code default.
 */
export function resolveFlags(overrides: unknown, rollouts: FlagRollouts = {}, merchantId: string | null = null): FeatureFlags {
  const parsed = FeatureFlagOverridesInput.safeParse(overrides ?? {});
  const o = parsed.success ? parsed.data : {};
  return Object.fromEntries(
    FEATURE_FLAG_KEYS.map((k) => {
      const r = rollouts[k];
      if (r?.stage === 'killed') return [k, false];
      return [k, o[k] ?? rolloutValue(k, r, merchantId) ?? FEATURE_FLAGS[k].default];
    }),
  ) as FeatureFlags;
}

// ───────────────────────────────────────────────────────────────────────── support chat ──

export const SupportMessageInput = z.strictObject({ body: z.string().trim().min(1).max(2_000) });

export interface SupportMessage {
  message_id: string;
  merchant_id: string;
  author_kind: 'merchant_user' | 'admin';
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface SupportConversation {
  merchant_id: string;
  merchant_name: string;
  last_message: SupportMessage;
  /** Messages from the merchant that AD Pay hasn't opened yet. */
  unread: number;
}
