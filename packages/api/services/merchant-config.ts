/**
 * Per-merchant configuration and support chat (build plan P12b, Bible L52 / L40, ADR 0021).
 *
 *  - Feature flags: overrides over the shared defaults, delivered in the config snapshot (a change
 *    bumps the catalog version, so registers pick it up on their next sync or the `/ws` nudge).
 *  - Vertical packs: enabling a pack seeds its starter categories (once, by name).
 *  - Support chat: one conversation per merchant, append-only, pushed live to both sides.
 *    "Share my screen from the register" needs the MDM vendor (open decision, ⛔).
 */
import {
  PACKS,
  resolveFlags,
  type FeatureFlagOverrides,
  type FeatureFlags,
  type PackId,
  type SupportConversation,
  type SupportMessage,
} from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';

export interface MerchantConfig {
  enabled_packs: PackId[];
  flags: FeatureFlags;
  overrides: FeatureFlagOverrides;
}

export async function merchantConfig(q: Queryable, merchantId: string): Promise<MerchantConfig> {
  const { rows } = await q.query<{ enabled_packs: PackId[]; feature_flags: FeatureFlagOverrides }>('SELECT enabled_packs, feature_flags FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  return { enabled_packs: rows[0].enabled_packs, flags: resolveFlags(rows[0].feature_flags), overrides: rows[0].feature_flags };
}

export async function setFeatureFlags(db: Db, actor: AdminPrincipal, merchantId: string, overrides: FeatureFlagOverrides, traceId: string): Promise<MerchantConfig> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; feature_flags: unknown }>('SELECT org_id, feature_flags FROM merchants WHERE merchant_id = $1 FOR UPDATE', [merchantId]);
    if (!rows[0]) throw notFound('Merchant not found');
    await q.query('UPDATE merchants SET feature_flags = $2 WHERE merchant_id = $1', [merchantId, JSON.stringify(overrides)]);
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'merchant.flags_set',
      tenancy: { org_id: rows[0].org_id, merchant_id: merchantId },
      target: merchantId,
      details: { from: rows[0].feature_flags, to: overrides, catalog_version: version },
      trace_id: traceId,
    });
  });
  return merchantConfig(db, merchantId);
}

/** Replace the enabled packs; newly enabled packs get their starter categories (skipping names already there). */
export async function setPacks(db: Db, actor: AdminPrincipal, merchantId: string, packs: PackId[], traceId: string): Promise<MerchantConfig> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; enabled_packs: PackId[] }>('SELECT org_id, enabled_packs FROM merchants WHERE merchant_id = $1 FOR UPDATE', [merchantId]);
    if (!rows[0]) throw notFound('Merchant not found');
    const before = rows[0].enabled_packs;
    await q.query('UPDATE merchants SET enabled_packs = $2 WHERE merchant_id = $1', [merchantId, packs]);
    const added = packs.filter((p) => !before.includes(p));
    for (const pack of added) {
      const { rows: n } = await q.query<{ n: number }>('SELECT coalesce(max(sort), -1)::int + 1 AS n FROM categories WHERE merchant_id = $1', [merchantId]);
      let sort = n[0]!.n;
      for (const c of PACKS[pack].defaultCategories) {
        await q.query(
          `INSERT INTO categories (org_id, merchant_id, name, sort, taxable, min_age, pack, restriction)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
            WHERE NOT EXISTS (SELECT 1 FROM categories WHERE merchant_id = $2 AND lower(name) = lower($3))`,
          [rows[0].org_id, merchantId, c.name, sort++, c.taxable, c.min_age, pack, c.restriction ?? null],
        );
      }
    }
    const version = await bumpCatalogVersion(q, merchantId);
    await audit(q, {
      actor,
      action: 'merchant.packs_set',
      tenancy: { org_id: rows[0].org_id, merchant_id: merchantId },
      target: merchantId,
      details: { from: before, to: packs, catalog_version: version },
      trace_id: traceId,
    });
  });
  return merchantConfig(db, merchantId);
}

// ───────────────────────────────────────────────────────────────────────── support chat ──

interface MessageRow {
  message_id: string;
  merchant_id: string;
  author_kind: SupportMessage['author_kind'];
  author_name: string | null;
  body: string;
  created_at: Date | string;
}
const toMessage = (r: MessageRow): SupportMessage => ({ ...r, created_at: new Date(r.created_at).toISOString() });

const MESSAGE_SELECT = `SELECT s.message_id, s.merchant_id, s.author_kind, coalesce(u.name, u.email) AS author_name, s.body, s.created_at
                          FROM support_messages s LEFT JOIN users u ON u.user_id = s.author_user_id`;

async function markRead(q: Queryable, merchantId: string, side: 'merchant' | 'admin') {
  await q.query(
    `INSERT INTO support_reads (merchant_id, side, last_read_at) VALUES ($1, $2, now())
     ON CONFLICT (merchant_id, side) DO UPDATE SET last_read_at = now()`,
    [merchantId, side],
  );
}

/** The conversation, oldest first; reading it marks it read for that side. */
export async function supportThread(db: Db, merchantId: string, side: 'merchant' | 'admin', limit = 200): Promise<SupportMessage[]> {
  const { rows } = await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE s.merchant_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [merchantId, limit]);
  await markRead(db, merchantId, side);
  return rows.reverse().map(toMessage);
}

export async function postSupportMessage(db: Db, actor: AdminPrincipal | MerchantUserPrincipal, merchantId: string, body: string, traceId: string): Promise<SupportMessage> {
  return db.tx(async (q) => {
    const { rows: m } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
    if (!m[0]) throw notFound('Merchant not found');
    const { rows } = await q.query<{ message_id: string }>(
      `INSERT INTO support_messages (org_id, merchant_id, author_kind, author_user_id, body, trace_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING message_id`,
      [m[0].org_id, merchantId, actor.kind, actor.user_id, body, traceId],
    );
    await markRead(q, merchantId, actor.kind === 'admin' ? 'admin' : 'merchant');
    const { rows: full } = await q.query<MessageRow>(`${MESSAGE_SELECT} WHERE s.message_id = $1`, [rows[0]!.message_id]);
    const message = toMessage(full[0]!);
    // Delivered live on commit (realtime hub); a body can be up to 2,000 chars, well inside NOTIFY's 8 kB.
    await q.query('SELECT pg_notify($1, $2)', ['adpay_support', JSON.stringify(message)]);
    return message;
  });
}

/** AD Pay's inbox: one row per merchant that has written, newest first, with unread counts. */
export async function supportInbox(q: Queryable): Promise<SupportConversation[]> {
  const { rows } = await q.query<MessageRow & { merchant_name: string; unread: number }>(
    `SELECT DISTINCT ON (s.merchant_id) s.message_id, s.merchant_id, s.author_kind, coalesce(u.name, u.email) AS author_name, s.body, s.created_at,
            m.name AS merchant_name,
            (SELECT count(*)::int FROM support_messages x
              WHERE x.merchant_id = s.merchant_id AND x.author_kind = 'merchant_user'
                AND x.created_at > coalesce((SELECT last_read_at FROM support_reads r WHERE r.merchant_id = s.merchant_id AND r.side = 'admin'), '-infinity')) AS unread
       FROM support_messages s JOIN merchants m ON m.merchant_id = s.merchant_id LEFT JOIN users u ON u.user_id = s.author_user_id
      ORDER BY s.merchant_id, s.created_at DESC`,
  );
  return rows
    .map(({ merchant_name, unread, ...r }) => ({ merchant_id: r.merchant_id, merchant_name, unread, last_message: toMessage(r) }))
    .sort((a, b) => b.last_message.created_at.localeCompare(a.last_message.created_at));
}
