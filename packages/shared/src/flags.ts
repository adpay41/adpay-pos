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

export function resolveFlags(overrides: unknown): FeatureFlags {
  const parsed = FeatureFlagOverridesInput.safeParse(overrides ?? {});
  const o = parsed.success ? parsed.data : {};
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((k) => [k, o[k] ?? FEATURE_FLAGS[k].default])) as FeatureFlags;
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
