/**
 * Languages (P18, ADR 0027). Bible 1.5: Spanish, Gujarati, Hindi, Bengali, Arabic, Korean, Chinese
 * and Haitian Creole on the customer screen, the cashier side chosen independently, and the receipt in
 * the customer's language (1.6).
 *
 * Strings come from built-in catalogs (i18n-messages.ts) with platform-wide overrides on top, edited
 * in admin → Translations and delivered to registers in the config snapshot. A language a store can
 * offer must not be `draft`; `reviewed` records that a fluent person signed it off. Nothing here has
 * had a professional review yet: that is outside the code (build plan).
 */
import { z } from 'zod';
import { BUILT_IN, EN, type MessageKey, type Messages } from './i18n-messages';

export { EN, type MessageKey, type Messages } from './i18n-messages';

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文', dir: 'ltr' },
  { code: 'ko', name: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', dir: 'ltr' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', dir: 'ltr' },
  { code: 'ht', name: 'Haitian Creole', native: 'Kreyòl ayisyen', dir: 'ltr' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];
export const LANG_CODES = LANGUAGES.map((l) => l.code) as [Lang, ...Lang[]];
export const LangSchema = z.enum(LANG_CODES);
export const languageInfo = (code: Lang) => LANGUAGES.find((l) => l.code === code)!;
export const isRtl = (code: Lang) => languageInfo(code).dir === 'rtl';

/**
 * draft: stores can't offer it. available: stores can offer it, not yet reviewed. reviewed: a fluent
 * person signed it off (who and when is recorded).
 */
export const LANGUAGE_STATUSES = ['draft', 'available', 'reviewed'] as const;
export type LanguageStatus = (typeof LANGUAGE_STATUSES)[number];

/**
 * Before anyone reviews them: the five catalogs we are most confident in are offerable; Bengali,
 * Gujarati and Haitian Creole wait as drafts until a fluent person checks them (or an admin decides).
 */
export const LANGUAGE_DEFAULT_STATUS: Record<Lang, LanguageStatus> = {
  en: 'reviewed',
  es: 'available',
  zh: 'available',
  ko: 'available',
  ar: 'available',
  hi: 'available',
  bn: 'draft',
  gu: 'draft',
  ht: 'draft',
};

export type Overrides = Partial<Record<Lang, Messages>>;
export const MESSAGE_KEYS = Object.keys(EN) as MessageKey[];
export const MessageKeySchema = z.enum(MESSAGE_KEYS as [MessageKey, ...MessageKey[]]);

/** What the register carries in its snapshot. */
export interface I18nSnapshot {
  /** Languages this location offers on the customer screen, English first; never a draft. */
  offered: Lang[];
  /** The customer screen starts every sale in this language. */
  default: Lang;
  overrides: Overrides;
}

export const DEFAULT_I18N: I18nSnapshot = { offered: ['en'], default: 'en', overrides: {} };

const fill = (text: string, vars?: Record<string, string | number>) =>
  vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;

/** One string: override, then the built-in catalog, then English. */
export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>, overrides?: Overrides): string {
  return fill(overrides?.[lang]?.[key] ?? BUILT_IN[lang][key] ?? overrides?.en?.[key] ?? EN[key], vars);
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang, overrides?: Overrides): Translate {
  return (key, vars) => translate(lang, key, vars, overrides);
}

/** The built-in string alone (what an override replaces), or null where the catalog has none. */
export const builtIn = (lang: Lang, key: MessageKey): string | null => BUILT_IN[lang][key] ?? null;

/** How much of a language is translated, counting overrides. */
export function coverage(lang: Lang, overrides?: Overrides): { translated: number; total: number; missing: MessageKey[] } {
  const missing = MESSAGE_KEYS.filter((k) => !(overrides?.[lang]?.[k] ?? BUILT_IN[lang][k]));
  return { translated: MESSAGE_KEYS.length - missing.length, total: MESSAGE_KEYS.length, missing };
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** A translation must keep exactly the English string's `{placeholders}`, or amounts go missing. */
export function placeholdersMatch(key: MessageKey, text: string): boolean {
  return placeholders(EN[key]) === placeholders(text);
}

/**
 * Which languages a location actually offers: English always first, then what it asked for that is
 * not a draft platform-wide, in the order it chose.
 */
export function offeredLanguages(wanted: readonly Lang[], statuses: Partial<Record<Lang, LanguageStatus>>): Lang[] {
  const ok = (l: Lang) => (statuses[l] ?? LANGUAGE_DEFAULT_STATUS[l]) !== 'draft';
  return ['en', ...wanted.filter((l, i) => l !== 'en' && ok(l) && wanted.indexOf(l) === i)];
}

// --- Display width on fixed-width paper (receipts) ------------------------------------------------

/** Combining marks and invisible formatting characters take no column. */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
/** East Asian wide and fullwidth characters take two columns on a thermal printer. */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;

const charWidth = (ch: string) => (ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1);

/** Columns a string takes on the receipt. */
export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** The longest prefix that fits in `width` columns (never splits a character from its marks). */
export function sliceCells(text: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > width) break;
    w += cw;
    out += ch;
  }
  return out;
}
