/**
 * Product photos (build plan P2). The `MediaStore` interface is the seam: v1 keeps bytes in Postgres
 * (`media` table, ADR 0010); S3 replaces it later without touching routes or the catalog.
 *
 * Rules enforced here, not in clients:
 *  - only JPEG / PNG / WebP, recognised by their magic bytes (the declared content type must agree);
 *  - at most MEDIA_MAX_BYTES;
 *  - content-addressed per merchant, so re-uploading the same photo returns the same id;
 *  - an item may reference only its own merchant's media (checked in catalog-write).
 */
import { createHash } from 'node:crypto';
import { MEDIA_MAX_BYTES, type MediaType } from '@adpay/shared';
import type { Queryable } from '../db/db';
import { badRequest } from '../http/errors';

export interface StoredMedia {
  media_id: string;
  content_type: MediaType;
  bytes: Buffer;
}

export interface PutMedia {
  org_id: string;
  merchant_id: string;
  bytes: Buffer;
  content_type: MediaType;
  created_by: string | null;
  trace_id: string;
}

export interface MediaStore {
  put(q: Queryable, m: PutMedia): Promise<{ media_id: string; created: boolean }>;
  get(q: Queryable, mediaId: string): Promise<StoredMedia | null>;
  /** True when `mediaId` exists and belongs to `merchantId`. */
  owns(q: Queryable, merchantId: string, mediaId: string): Promise<boolean>;
}

/** What the bytes actually are, from their signature; null if not an accepted image type. */
export function sniffImageType(b: Buffer): MediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function validateImage(bytes: Buffer, declared: string | undefined): MediaType {
  if (bytes.length === 0) throw badRequest('The photo is empty');
  if (bytes.length > MEDIA_MAX_BYTES) throw badRequest(`Photos must be under ${Math.floor(MEDIA_MAX_BYTES / 1000)} KB — try a smaller one`);
  const actual = sniffImageType(bytes);
  if (!actual) throw badRequest('Photos must be JPEG, PNG or WebP');
  const claimed = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (claimed !== actual) throw badRequest(`The file says ${claimed || 'nothing'} but contains ${actual}`);
  return actual;
}

export const mediaUrl = (mediaId: string) => `/media/${mediaId}`;

export const pgMediaStore: MediaStore = {
  async put(q, m) {
    const sha256 = createHash('sha256').update(m.bytes).digest('hex');
    const { rows } = await q.query<{ media_id: string }>(
      `INSERT INTO media (org_id, merchant_id, sha256, content_type, byte_size, bytes, created_by, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (merchant_id, sha256) DO NOTHING
       RETURNING media_id`,
      [m.org_id, m.merchant_id, sha256, m.content_type, m.bytes.length, m.bytes, m.created_by, m.trace_id],
    );
    if (rows[0]) return { media_id: rows[0].media_id, created: true };
    const existing = await q.query<{ media_id: string }>('SELECT media_id FROM media WHERE merchant_id = $1 AND sha256 = $2', [
      m.merchant_id,
      sha256,
    ]);
    return { media_id: existing.rows[0]!.media_id, created: false };
  },

  async get(q, mediaId) {
    const { rows } = await q.query<{ media_id: string; content_type: MediaType; bytes: Buffer | Uint8Array }>(
      'SELECT media_id, content_type, bytes FROM media WHERE media_id = $1',
      [mediaId],
    );
    const r = rows[0];
    return r ? { media_id: r.media_id, content_type: r.content_type, bytes: Buffer.from(r.bytes) } : null;
  },

  async owns(q, merchantId, mediaId) {
    const { rows } = await q.query('SELECT 1 FROM media WHERE media_id = $1 AND merchant_id = $2', [mediaId, merchantId]);
    return rows.length > 0;
  },
};
