/**
 * Documents vault (Bible 2.8; P24b, ADR 0037): licences, permits, certificates and insurance as
 * uploaded files with an expiry date. The `document_expiring` alert reminds the owner 30 days ahead.
 *
 * Bytes live in Postgres like product photos (ADR 0010), behind `DocumentStore`, so S3 can replace it
 * without touching routes. Documents are immutable: a renewal is a new upload that archives the one it
 * replaces, in the same transaction; "remove" archives, nothing is deleted.
 */
import { createHash } from 'node:crypto';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_REMIND_DAYS,
  sniffDocumentType,
  type DocumentKind,
  type DocumentMetaInput,
  type DocumentType,
} from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';

export interface StoredDocument {
  bytes: Buffer;
  content_type: DocumentType;
  title: string;
}

export interface DocumentStore {
  put(q: Queryable, row: { org_id: string; merchant_id: string; meta: DocumentMetaInput; bytes: Buffer; content_type: DocumentType; uploaded_by: string; trace_id: string }): Promise<string>;
  get(q: Queryable, merchantId: string | null, documentId: string): Promise<StoredDocument | null>;
}

export const pgDocumentStore: DocumentStore = {
  async put(q, r) {
    const sha256 = createHash('sha256').update(r.bytes).digest('hex');
    const { rows } = await q.query<{ document_id: string }>(
      `INSERT INTO documents (org_id, merchant_id, location_id, kind, title, expires_on, content_type, byte_size, sha256, bytes, replaces, uploaded_by, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING document_id`,
      [r.org_id, r.merchant_id, r.meta.location_id, r.meta.kind, r.meta.title, r.meta.expires_on, r.content_type, r.bytes.length, sha256, r.bytes, r.meta.replaces, r.uploaded_by, r.trace_id],
    );
    return rows[0]!.document_id;
  },
  async get(q, merchantId, documentId) {
    const { rows } = await q.query<{ bytes: Buffer; content_type: DocumentType; title: string }>(
      'SELECT bytes, content_type, title FROM documents WHERE document_id = $1 AND ($2::uuid IS NULL OR merchant_id = $2)',
      [documentId, merchantId],
    );
    return rows[0] ?? null;
  },
};

/** Checks the bytes are what the upload says they are, and small enough. */
export function validateDocument(bytes: Buffer, declared: string | undefined): DocumentType {
  if (bytes.length === 0) throw badRequest('The file is empty');
  if (bytes.length > DOCUMENT_MAX_BYTES) throw badRequest(`Documents must be under ${DOCUMENT_MAX_BYTES / 1_000_000} MB`);
  const actual = sniffDocumentType(bytes);
  if (!actual) throw badRequest('Documents must be a PDF, JPEG or PNG');
  const claimed = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (claimed !== actual) throw badRequest(`The file says ${claimed || 'nothing'} but contains ${actual}`);
  return actual;
}

export interface DocumentRow {
  document_id: string;
  kind: DocumentKind;
  title: string;
  location_id: string | null;
  location_name: string | null;
  expires_on: string | null;
  content_type: DocumentType;
  byte_size: number;
  uploaded_by_name: string | null;
  created_at: string;
  /** Earlier versions this one replaced, newest first. */
  replaced: { document_id: string; expires_on: string | null; created_at: string }[];
}

/** The vault: current documents (not archived), each with the versions it replaced. */
export async function listDocuments(q: Queryable, merchantId: string): Promise<DocumentRow[]> {
  const { rows } = await q.query<Omit<DocumentRow, 'replaced'> & { replaces: string | null; archived: boolean }>(
    `SELECT d.document_id, d.kind, d.title, d.location_id, l.name AS location_name, to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on,
            d.content_type, d.byte_size, u.name AS uploaded_by_name, d.created_at, d.replaces, (a.document_id IS NOT NULL) AS archived
       FROM documents d
       LEFT JOIN locations l ON l.location_id = d.location_id
       LEFT JOIN users u ON u.user_id = d.uploaded_by
       LEFT JOIN document_archives a ON a.document_id = d.document_id
      WHERE d.merchant_id = $1
      ORDER BY d.expires_on NULLS LAST, d.title`,
    [merchantId],
  );
  const byId = new Map(rows.map((r) => [r.document_id, r]));
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return rows
    .filter((r) => !r.archived)
    .map((r) => {
      const replaced: DocumentRow['replaced'] = [];
      for (let p = r.replaces ? byId.get(r.replaces) : undefined; p && replaced.length < 20; p = p.replaces ? byId.get(p.replaces) : undefined) {
        replaced.push({ document_id: p.document_id, expires_on: p.expires_on, created_at: iso(p.created_at) });
      }
      const { replaces: _r, archived: _a, ...rest } = r;
      return { ...rest, created_at: iso(r.created_at), replaced };
    });
}

export async function uploadDocument(db: Db, actor: MerchantUserPrincipal, meta: DocumentMetaInput, bytes: Buffer, type: DocumentType, traceId: string): Promise<{ document_id: string }> {
  return db.tx(async (q) => {
    const { rows: m } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [actor.merchant_id]);
    if (!m[0]) throw notFound('Merchant not found');
    if (meta.location_id) {
      const { rows } = await q.query('SELECT 1 FROM locations WHERE location_id = $1 AND merchant_id = $2', [meta.location_id, actor.merchant_id]);
      if (!rows.length) throw badRequest('That store was not found');
    }
    if (meta.replaces) {
      const { rows } = await q.query<{ archived: boolean }>(
        `SELECT (a.document_id IS NOT NULL) AS archived FROM documents d LEFT JOIN document_archives a ON a.document_id = d.document_id
          WHERE d.document_id = $1 AND d.merchant_id = $2 FOR UPDATE OF d`,
        [meta.replaces, actor.merchant_id],
      );
      if (!rows[0]) throw badRequest('The document being replaced was not found');
      if (rows[0].archived) throw badRequest('That document was already replaced or removed');
    }
    const id = await pgDocumentStore.put(q, { org_id: m[0].org_id, merchant_id: actor.merchant_id, meta, bytes, content_type: type, uploaded_by: actor.user_id, trace_id: traceId });
    if (meta.replaces) {
      await q.query(`INSERT INTO document_archives (document_id, reason, archived_by, trace_id) VALUES ($1, 'replaced', $2, $3)`, [meta.replaces, actor.user_id, traceId]);
    }
    await audit(q, {
      actor,
      action: meta.replaces ? 'document.renewed' : 'document.uploaded',
      tenancy: { org_id: m[0].org_id, merchant_id: actor.merchant_id, ...(meta.location_id ? { location_id: meta.location_id } : {}) },
      target: id,
      details: { kind: meta.kind, title: meta.title, expires_on: meta.expires_on, replaces: meta.replaces, byte_size: bytes.length },
      trace_id: traceId,
    });
    return { document_id: id };
  });
}

export async function removeDocument(db: Db, actor: MerchantUserPrincipal, documentId: string, traceId: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string; archived: boolean }>(
      `SELECT d.org_id, (a.document_id IS NOT NULL) AS archived FROM documents d LEFT JOIN document_archives a ON a.document_id = d.document_id
        WHERE d.document_id = $1 AND d.merchant_id = $2`,
      [documentId, actor.merchant_id],
    );
    if (!rows[0] || rows[0].archived) throw notFound('Document not found');
    await q.query(`INSERT INTO document_archives (document_id, reason, archived_by, trace_id) VALUES ($1, 'removed', $2, $3)`, [documentId, actor.user_id, traceId]);
    await audit(q, { actor, action: 'document.removed', tenancy: { org_id: rows[0].org_id, merchant_id: actor.merchant_id }, target: documentId, trace_id: traceId });
  });
}

/** Admin read (support helps a store find its licence); audited, since these are the store's papers. */
export async function adminDocumentFile(db: Db, actor: AdminPrincipal, documentId: string, traceId: string): Promise<StoredDocument> {
  const doc = await pgDocumentStore.get(db, null, documentId);
  if (!doc) throw notFound('Document not found');
  await audit(db, { actor, action: 'document.viewed', target: documentId, trace_id: traceId });
  return doc;
}

export interface ExpiringDocument {
  document_id: string;
  org_id: string;
  merchant_id: string;
  location_id: string | null;
  title: string;
  expires_on: string;
  days_left: number;
}

/** Current documents expiring within the reminder window (or already expired), for the alert rule. */
export async function expiringDocuments(q: Queryable, today: string): Promise<ExpiringDocument[]> {
  const { rows } = await q.query<ExpiringDocument>(
    `SELECT d.document_id, d.org_id, d.merchant_id, d.location_id, d.title, to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on,
            (d.expires_on - $1::date)::int AS days_left
       FROM documents d
      WHERE d.expires_on IS NOT NULL AND d.expires_on <= $1::date + $2::int
        AND NOT EXISTS (SELECT 1 FROM document_archives a WHERE a.document_id = d.document_id)
      ORDER BY d.expires_on`,
    [today, DOCUMENT_REMIND_DAYS],
  );
  return rows;
}
