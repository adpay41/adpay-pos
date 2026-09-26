/**
 * Documents vault (Bible 2.8; P24b): the store's licences, permits, certificates and insurance, kept
 * as uploaded files with an expiry date, so the owner is reminded before the inspector finds it.
 * A document is never edited: a renewal is a new upload that replaces the old one.
 */
import { z } from 'zod';

export const DOCUMENT_KINDS = {
  business_licence: 'Business licence / certificate of occupancy',
  tobacco_licence: 'Tobacco / vape retail licence',
  liquor_licence: 'Liquor licence',
  food_licence: 'Food establishment permit / health inspection',
  sales_tax_certificate: 'Sales tax certificate of authority',
  weights_measures: 'Weights & measures (scale) certificate',
  insurance: 'Insurance certificate',
  lease: 'Lease',
  other: 'Other',
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;
export const DOCUMENT_KIND_KEYS = Object.keys(DOCUMENT_KINDS) as DocumentKind[];

export const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_MAX_BYTES = 5_000_000;
/** The reminder opens this many days before a document expires. */
export const DOCUMENT_REMIND_DAYS = 30;

/** Sent as query parameters next to the raw file body. */
export const DocumentMetaInput = z.strictObject({
  kind: z.enum(DOCUMENT_KIND_KEYS as [DocumentKind, ...DocumentKind[]]),
  title: z.string().trim().min(2).max(120),
  location_id: z.uuid().nullable().default(null),
  expires_on: z.iso.date().nullable().default(null),
  /** A renewal: the document this one replaces (archived in the same step). */
  replaces: z.uuid().nullable().default(null),
});
export type DocumentMetaInput = z.infer<typeof DocumentMetaInput>;

export type ExpiryStatus = 'none' | 'ok' | 'soon' | 'expired';

/** Whole days from `today` to `expiresOn` (both YYYY-MM-DD); negative once expired. */
export function daysUntil(expiresOn: string, today: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function expiryStatus(expiresOn: string | null, today: string): ExpiryStatus {
  if (!expiresOn) return 'none';
  const d = daysUntil(expiresOn, today);
  if (d < 0) return 'expired';
  return d <= DOCUMENT_REMIND_DAYS ? 'soon' : 'ok';
}

/** What the file actually is, from its first bytes; null if not accepted. */
export function sniffDocumentType(b: Uint8Array): DocumentType | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}
