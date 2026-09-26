/**
 * The cashier's language on the register (P18b, ADR 0028), chosen independently of the customer
 * screen (Bible 1.5). Strings are keyed by their English text: `t('Void ticket')`,
 * `t('Paid {amount} by card', { amount })`. The keys are the shared `CASHIER_EN` list (generated
 * from this app's source by `pnpm --filter @adpay/register i18n:extract`), so admin → Translations
 * can correct every one; a string with no translation shows in English.
 *
 * The choice is remembered per cashier on this register (and, before anyone signs in, for the
 * register itself), in the local store: it works offline and never touches the sale log.
 */
import { DEFAULT_I18N, translate, type CashierKey, type Lang, type Overrides } from '@adpay/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Runtime } from '../runtime';

export type T = (english: CashierKey, vars?: Record<string, string | number>) => string;

interface Ctx {
  t: T;
  lang: Lang;
  /** Languages the cashier may pick: English and every one not in draft platform-wide. */
  choices: Lang[];
  setLang: (lang: Lang) => void;
}

const english: T = (key, vars) => translate('en', key, vars);
const Context = createContext<Ctx>({ t: english, lang: 'en', choices: ['en'], setLang: () => undefined });

const REGISTER_KEY = 'cashier_lang';
const personKey = (userId: string) => `cashier_lang:${userId}`;

/** Holds the cashier's language for everything under it; follows who is signed in. */
export function CashierLanguage({ rt, children }: { rt: Runtime; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  const [i18n, setI18n] = useState(rt.catalog.i18n ?? DEFAULT_I18N);
  useEffect(() => rt.sync.onCatalog((c) => setI18n(c.i18n ?? DEFAULT_I18N)), [rt]);
  const choices = useMemo(() => (i18n.cashier?.length ? i18n.cashier : ['en' as Lang]), [i18n]);

  // Whoever signs in gets their own last choice; with nobody signed in, the register's.
  const [who, setWho] = useState<string | null>(rt.staff.state().member?.user_id ?? null);
  useEffect(() => rt.staff.subscribe((s) => setWho(s.member?.user_id ?? null)), [rt]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const saved = (who ? await rt.store.getMeta(personKey(who)) : null) ?? (await rt.store.getMeta(REGISTER_KEY));
      if (live && saved && (choices as string[]).includes(saved)) setLangState(saved as Lang);
    })();
    return () => {
      live = false;
    };
  }, [rt, who, choices]);

  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      void rt.store.setMeta(REGISTER_KEY, l);
      if (who) void rt.store.setMeta(personKey(who), l);
    },
    [rt, who],
  );

  const overrides: Overrides = i18n.overrides;
  const value = useMemo<Ctx>(() => ({ lang, choices, setLang, t: ((key, vars) => translate(lang, key, vars, overrides)) as T }), [lang, choices, setLang, overrides]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The translator for the cashier's language. */
export const useT = (): T => useContext(Context).t;
export const useCashierLanguage = () => useContext(Context);

/**
 * Marks a string as a translation key where it's defined but translated where it's shown:
 * `const ROLE = { cashier: tk('Cashier') }` … `t(ROLE[m.role])`. The extract script finds these too.
 */
export const tk = <K extends CashierKey>(english: K): K => english;

/**
 * Text that was stored (a paid-out reason in an event): shown translated when it is one of our
 * preset keys, as written when someone typed it.
 */
export const storedText = (text: string): CashierKey => text as CashierKey;
