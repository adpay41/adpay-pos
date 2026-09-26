/**
 * Languages, translations management and the digital receipt page (P18, ADR 0027).
 *
 * Language status and string overrides are platform-wide configuration: admins edit them, every
 * register gets them in its next config snapshot (a change bumps every merchant's catalog version).
 * The receipt page is public by an unguessable token captured on the sale; it shows exactly what the
 * printer printed (same renderer), in the sale's language.
 */
import {
  builtIn,
  coverage,
  EN,
  isRtl,
  LANG_CODES,
  LANGUAGE_DEFAULT_STATUS,
  LANGUAGES,
  MESSAGE_KEYS,
  offeredLanguages,
  placeholdersMatch,
  RegisterEventSchema,
  foldSale,
  renderReceipt,
  type I18nSnapshot,
  type Lang,
  type LanguageStatus,
  type MessageKey,
  type Overrides,
  type ReceiptLine,
  type ReceiptSettings,
} from '@adpay/shared';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest } from '../http/errors';
import { audit } from './audit';
import { receiptSettingsOf } from './catalog';
import { mediaUrl } from './media';

export async function languageStatuses(q: Queryable): Promise<Record<Lang, LanguageStatus>> {
  const { rows } = await q.query<{ lang: Lang; status: LanguageStatus }>('SELECT lang, status FROM language_settings');
  const out = { ...LANGUAGE_DEFAULT_STATUS };
  for (const r of rows) if (r.lang in out) out[r.lang] = r.status;
  return out;
}

export async function translationOverrides(q: Queryable): Promise<Overrides> {
  const { rows } = await q.query<{ lang: Lang; key: MessageKey; text: string }>('SELECT lang, key, text FROM translation_overrides');
  const out: Overrides = {};
  for (const r of rows) (out[r.lang] ??= {})[r.key] = r.text;
  return out;
}

/** The register's language slice of the snapshot: what this location offers, with the overrides. */
export async function i18nSnapshot(q: Queryable, receipt: ReceiptSettings): Promise<I18nSnapshot> {
  const offered = offeredLanguages(receipt.languages, await languageStatuses(q));
  const overrides = await translationOverrides(q);
  const only: Overrides = {};
  for (const l of offered) if (overrides[l]) only[l] = overrides[l];
  return { offered, default: offered.includes(receipt.default_language) ? receipt.default_language : 'en', overrides: only };
}

/** Admin → Translations: every language with its status, reviewer and coverage. */
export async function translationsOverview(q: Queryable) {
  const { rows } = await q.query<{ lang: Lang; status: LanguageStatus; reviewed_at: Date | null; review_note: string | null; reviewer: string | null }>(
    `SELECT s.lang, s.status, s.reviewed_at, s.review_note, u.name AS reviewer
       FROM language_settings s LEFT JOIN users u ON u.user_id = s.reviewed_by`,
  );
  const overrides = await translationOverrides(q);
  const { rows: offeredBy } = await q.query<{ lang: string; n: number }>(
    `SELECT lang, count(*)::int AS n FROM locations, jsonb_array_elements_text(COALESCE(receipt_settings->'languages', '["en","es"]'::jsonb)) AS lang GROUP BY lang`,
  );
  return {
    languages: LANGUAGES.map((l) => {
      const row = rows.find((r) => r.lang === l.code);
      const c = coverage(l.code, overrides);
      return {
        ...l,
        status: row?.status ?? LANGUAGE_DEFAULT_STATUS[l.code],
        reviewed_by: row?.status === 'reviewed' ? row.reviewer : null,
        reviewed_at: row?.status === 'reviewed' && row.reviewed_at ? row.reviewed_at.toISOString() : null,
        review_note: row?.review_note ?? null,
        translated: c.translated,
        total: c.total,
        overrides: Object.keys(overrides[l.code] ?? {}).length,
        locations_asking: l.code === 'en' ? null : (offeredBy.find((o) => o.lang === l.code)?.n ?? 0),
      };
    }),
  };
}

/** One language's strings side by side: English, the built-in translation, the override in force. */
export async function translationStrings(q: Queryable, lang: Lang) {
  const overrides = (await translationOverrides(q))[lang] ?? {};
  return {
    lang,
    strings: MESSAGE_KEYS.map((key) => ({
      key,
      english: EN[key],
      built_in: builtIn(lang, key),
      override: overrides[key] ?? null,
    })),
  };
}

async function bumpAllCatalogs(q: Queryable): Promise<void> {
  await q.query('UPDATE merchants SET catalog_version = catalog_version + 1');
}

export async function setLanguageStatus(db: Db, actor: AdminPrincipal, lang: Lang, status: LanguageStatus, note: string | null, traceId: string): Promise<void> {
  if (lang === 'en' && status !== 'reviewed') throw badRequest('English is the source language and is always offered');
  await db.tx(async (q) => {
    const reviewed = status === 'reviewed';
    await q.query(
      `INSERT INTO language_settings (lang, status, reviewed_by, reviewed_at, review_note, updated_by, updated_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, $5, $6, now())
       ON CONFLICT (lang) DO UPDATE SET status = EXCLUDED.status, reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = EXCLUDED.reviewed_at, review_note = EXCLUDED.review_note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [lang, status, reviewed ? actor.user_id : null, reviewed, note, actor.user_id],
    );
    await bumpAllCatalogs(q);
    await audit(q, { actor, action: 'i18n.language_status_set', target: lang, details: { status, note }, trace_id: traceId });
  });
}

/** Set (or with `text` null, remove) one override. A translation must keep the English placeholders. */
export async function setTranslation(db: Db, actor: AdminPrincipal, lang: Lang, key: MessageKey, text: string | null, traceId: string): Promise<void> {
  if (text !== null && !placeholdersMatch(key, text)) {
    throw badRequest(`Keep the same {placeholders} as the English: “${EN[key]}”`);
  }
  await db.tx(async (q) => {
    if (text === null) await q.query('DELETE FROM translation_overrides WHERE lang = $1 AND key = $2', [lang, key]);
    else
      await q.query(
        `INSERT INTO translation_overrides (lang, key, text, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lang, key) DO UPDATE SET text = EXCLUDED.text, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [lang, key, text, actor.user_id],
      );
    await bumpAllCatalogs(q);
    await audit(q, { actor, action: 'i18n.translation_set', target: `${lang}.${key}`, details: { text }, trace_id: traceId });
  });
}

// --- Digital receipt ------------------------------------------------------------------------------

export interface ReceiptPage {
  lang: Lang;
  merchant_name: string;
  lines: ReceiptLine[];
}

/** The receipt behind a token, rendered as printed; null when the sale hasn't synced (or never existed). */
export async function receiptByToken(q: Queryable, token: string): Promise<ReceiptPage | null> {
  const { rows: hit } = await q.query<{ sale_id: string }>(
    `SELECT sale_id FROM sale_events WHERE type = 'sale.completed' AND payload->>'receipt_token' = $1 LIMIT 1`,
    [token],
  );
  if (!hit[0]) return null;
  const { rows } = await q.query<Record<string, unknown> & { occurred_at: Date; location_id: string }>(
    `SELECT event_id, schema_version, sale_id, device_seq, occurred_at, org_id, merchant_id, location_id, register_id, trace_id, actor_user_id, type, payload
       FROM sale_events WHERE sale_id = $1 ORDER BY device_seq`,
    [hit[0].sale_id],
  );
  const events = rows.map((r) => RegisterEventSchema.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() }));
  const sale = foldSale(hit[0].sale_id, events);
  const completed = events.find((e) => e.type === 'sale.completed')!;
  const { rows: where } = await q.query<{
    merchant_name: string; location_name: string; address_line1: string | null; city: string | null; state: string | null;
    postal_code: string | null; timezone: string; register_name: string; receipt_settings: unknown;
  }>(
    `SELECT m.name AS merchant_name, l.name AS location_name, l.address_line1, l.city, l.state, l.postal_code, l.timezone,
            r.name AS register_name, l.receipt_settings
       FROM registers r JOIN locations l ON l.location_id = r.location_id JOIN merchants m ON m.merchant_id = l.merchant_id
      WHERE r.register_id = $1`,
    [completed.register_id],
  );
  const w = where[0]!;
  const settings = receiptSettingsOf(w.receipt_settings);
  const lang = sale.language ?? 'en';
  const overrides = await translationOverrides(q);
  return {
    lang,
    merchant_name: w.merchant_name,
    lines: renderReceipt({
      header: {
        merchant_name: w.merchant_name,
        location_name: w.location_name,
        address_line1: w.address_line1,
        city_state_zip: [w.city, [w.state, w.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
        register_name: w.register_name,
      },
      sale,
      occurred_at: completed.occurred_at,
      timezone: w.timezone,
      copy: 'original',
      // No QR on the page itself: it would point back here.
      settings: { ...settings, qr: null },
      logo_url: settings.logo_media_id ? mediaUrl(settings.logo_media_id) : null,
      lang,
      overrides,
    }),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small self-contained page: no scripts, no external requests, the receipt as printed. */
export function receiptHtml(page: ReceiptPage | null): string {
  if (!page) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20"><meta name="robots" content="noindex"><title>Receipt</title>
<style>body{font:16px system-ui,sans-serif;color:#111;background:#fff;margin:0;padding:48px 16px;text-align:center}</style></head>
<body><h1 style="font-size:22px">Your receipt is on its way</h1><p>The store’s register sends it within a minute or two. This page checks again by itself.</p></body></html>`;
  }
  const body = page.lines
    .map((l) =>
      l.style === 'logo'
        ? `<img src="${esc(l.url)}" alt="${esc(page.merchant_name)}" class="logo">`
        : l.style === 'qr'
          ? ''
          : `<div class="${l.style}">${esc(l.text) || '&nbsp;'}</div>`,
    )
    .join('\n');
  return `<!doctype html><html lang="${page.lang}" dir="${isRtl(page.lang) ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(page.merchant_name)}</title>
<style>
:root{--ink:#111;--paper:#fff;--ground:#f3f3f3}
@media (prefers-color-scheme:dark){:root{--ink:#111;--paper:#fff;--ground:#222}}
body{margin:0;background:var(--ground);padding:16px}
.paper{max-width:430px;margin:0 auto;background:var(--paper);color:var(--ink);padding:20px 16px;border-radius:6px;
font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre;overflow-x:auto;direction:ltr;unicode-bidi:plaintext}
.paper div{unicode-bidi:plaintext}.bold{font-weight:700}.double{font-weight:700;font-size:15px}
.logo{display:block;max-width:60%;max-height:90px;margin:0 auto 8px}
</style></head><body><main class="paper">
${body}
</main></body></html>`;
}

export const isLang = (v: string): v is Lang => (LANG_CODES as readonly string[]).includes(v);
