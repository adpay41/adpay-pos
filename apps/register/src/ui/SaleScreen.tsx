/**
 * Merchant-facing 15.6" sale screen: quick keys → ticket → cash tender → drawer → receipt.
 * Every button calls the SaleSession, which appends events; the ticket shown is the fold of those
 * events. Works fully offline; the sync pill shows what's queued.
 */
import {
  DEFAULT_I18N,
  localMoment,
  promotionActive,
  promotionText,
  type LoyaltyStatus,
  languageInfo,
  type Lang,
  WedgeDecoder,
  barcodeIndex,
  cardAmountFor,
  categoryKeys,
  cents,
  deriveCardPrice,
  departmentItem,
  favoriteKeys,
  foldSale,
  bagFeesOn,
  effectiveMinAge,
  feeItem,
  ID_FLAG_TEXT,
  checkId,
  dropSuggestion,
  type IdCheck,
  hhmm,
  lineAmount,
  shownTotals,
  pctChangeText,
  resolveFlags,
  localDate,
  lookupBarcode,
  searchCatalog,
  renderReceipt,
  renderZReport,
  type ZReport,
  type CashierUsual,
  type CatalogItem,
  type CatalogSnapshot,
  type Cents,
  type FoldedSale,
  type Permission,
  type ReceiptLine,
} from '@adpay/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DevSettings, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createDisplayChannel, displayFor, type DisplayState } from '../core/display';
import { PREVIEW_HEALTH, WebPreviewHardware, type Hardware } from '../core/hardware';
import type { SessionState } from '../core/session';
import { pendingItem } from '../core/new-items';
import { repeatBatch, ringBatch, usualBatch, usualLinesFrom, type Batch } from '../core/usuals';
import type { StaffState } from '../core/staff';
import type { SyncStatus } from '../core/sync';
import { API_URL, type Runtime } from '../runtime';
import { LanguageButton } from './LanguageUI';
import { Qr } from './Qr';
import { ReceivePanel, WriteOffPanel } from './ReceiveUI';
import { ChecklistPanel } from './ChecklistUI';
import { AmountKey, QuickKey } from './QuickKey';
import { DrawerPanel } from './DrawerUI';
import { CardPanel, type CardPhase } from './TenderUI';
import { HeldTickets, TicketBrowser } from './TicketsUI';
import { findByPlu, padCents, padQty } from '../core/pad';
import { BasketPanel } from './BasketUI';
import { OtherTenderPanel } from './OtherTenderUI';
import { ReturnStartPanel } from './ReturnUI';
import { TAX_EXEMPT_LABEL, TaxFreePanel } from './TaxFreeUI';
import { RegisterPad } from './RegisterPad';
import { NumberPad, PriceCheckCard, UnknownItemForm } from './SpeedUI';
import { OverridePrompt, SignInScreen } from './StaffUI';
import { C, usd } from './theme';
import { useT } from './i18n';

const FAVORITES = '__favorites__';
/** A tile on a named key page: an item, or an amount to a department (ADR 0047). */
type PageTile =
  | { kind: 'item'; key: string; item: CatalogItem }
  | { kind: 'department'; key: string; cat: CatalogSnapshot['categories'][number]; amount: number | null; label: string };
/** A named key page's tab (ADR 0047): this prefix + its page_id. */
const PAGE = '__page__:';

type Entry = 'key' | 'scan' | 'search' | 'new_item';

type Modal =
  | { kind: 'none' }
  | { kind: 'age'; item: CatalogItem; qty: number; entry: Entry; labelPrice?: number }
  | { kind: 'add_qty'; item: CatalogItem; entry: Entry }
  | { kind: 'set_qty'; line_id: string; name: string; qty: number }
  | { kind: 'open_price'; item: CatalogItem; qty: number; entry: Entry; ageConfirmed: boolean }
  | { kind: 'unknown'; code: string }
  | { kind: 'price_check'; item: CatalogItem; showCost: boolean }
  | { kind: 'drawer'; startWithFloat: boolean; thenCash: boolean; counterfeit?: boolean }
  | { kind: 'held' }
  | { kind: 'tickets' }
  | { kind: 'card'; phase: CardPhase }
  | { kind: 'done'; sale: FoldedSale; change: number; after: 'ask' | 'print' | 'none'; printed: readonly ReceiptLine[] | null }
  | { kind: 'receipt'; lines: readonly ReceiptLine[]; title: string }
  | { kind: 'device' }
  | { kind: 'override'; permission: Permission; saleId: string | null; then: () => Promise<unknown> }
  /** `done`: a confirmation (received, written off, checklist saved), not a refusal. */
  | { kind: 'error'; message: string; done?: boolean }
  | { kind: 'batch_age'; batch: Batch; label: string }
  | { kind: 'save_usual' }
  | { kind: 'eod'; z: ZReport | null; lines: string[] | null; done: boolean }
  | { kind: 'remove_usual'; usual: CashierUsual }
  | { kind: 'receive' }
  | { kind: 'write_off' }
  | { kind: 'checklist' }
  | { kind: 'basket' }
  | { kind: 'tax_free' }
  | { kind: 'other_tender' }
  | { kind: 'return_start' };

export function SaleScreen({ rt, onForget }: { rt: Runtime; onForget: () => void }) {
  const t = useT();
  // Long-lived callbacks (printer preview, remote-action handlers) read the current language through this.
  const tRef = useRef(t);
  tRef.current = t;
  const [catalog, setCatalog] = useState<CatalogSnapshot>(rt.catalog);
  // Training mode (P16, Bible 1.8): a separate in-memory session that is never synced or saved.
  const [training, setTraining] = useState(false);
  const ses = training ? rt.training : rt.session;
  const [session, setSession] = useState<SessionState>(ses.state());
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // FAVORITES is the location's own first page; a store without favorites opens on its first category.
  const [category, setCategory] = useState<string | null>(favoriteKeys(rt.catalog).length ? FAVORITES : (rt.catalog.categories[0]?.category_id ?? null));
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  // What's typed on the register pad (layout A), in cents digits.
  const [pad, setPad] = useState('');
  // A count set with the @ key (ADR 0047): the next item rings that many times.
  const [atQty, setAtQty] = useState<number | null>(null);
  const [drawerFlash, setDrawerFlash] = useState(false);
  const display = useRef(createDisplayChannel()).current;

  // Languages and the digital receipt (P18). The customer picks a language on their screen; the sale
  // records it and the receipt prints in it. Each new customer starts in the store's default.
  const i18n = catalog.i18n ?? DEFAULT_I18N;
  const digital = (catalog.receipt?.digital_receipt ?? false) && !training;
  const [customerLang, setCustomerLang] = useState<Lang>(i18n.default);
  // Loyalty by phone (P19a): who the ticket is for (hash + last four), and their standing from the server.
  const loyaltySettings = !training && catalog.loyalty?.settings.enabled ? catalog.loyalty.settings : null;
  type Cust = { saleId: string; ref: string; last4: string; status: LoyaltyStatus | null; offline: boolean };
  const [cust, setCust] = useState<Cust | null>(null);
  const [receiptText, setReceiptText] = useState<DisplayState['receipt_text']>(null);
  const ctx = useRef({ language: customerLang, i18n, digital, loyaltySettings, cust, receiptText, deals: (): string[] => [] });
  const deals = () => {
    const now = localMoment(new Date(), rt.identity.timezone);
    return (catalog.promotions ?? []).filter((p) => p.show_on_idle && promotionActive(p, rt.identity.location_id, now)).slice(0, 4).map(promotionText);
  };
  ctx.current = { language: customerLang, i18n, digital, loyaltySettings, cust, receiptText, deals };
  const sesRef = useRef(ses);
  sesRef.current = ses;
  const lastArgs = useRef<Parameters<typeof show> | null>(null);
  const lastShown = useRef<DisplayState | null>(null);
  const receiptUrl = (token: string) => `${API_URL}/r/${token}`;
  const show = useCallback(
    (s: FoldedSale | null, paid?: { amount: number; change: number }, card?: { phase: 'card' | 'approved' | 'declined'; amount: number }) => {
      const c = ctx.current;
      const state: DisplayState = {
        ...displayFor(rt.identity.merchant_name, s, paid, card),
        language: c.language,
        languages: c.i18n.offered,
        overrides: c.i18n.overrides,
        receipt_url: paid && c.digital && s?.receipt_token ? `${API_URL}/r/${s.receipt_token}` : null,
        loyalty: c.loyaltySettings
          ? {
              ask_texts: c.loyaltySettings.ask_for_texts,
              last4: c.cust && s && c.cust.saleId === s.sale_id ? c.cust.last4 : null,
              status: c.cust && s && c.cust.saleId === s.sale_id && c.cust.status ? c.cust.status : null,
              offline: !!(c.cust && c.cust.offline),
              redeemed: !!s?.loyalty,
            }
          : null,
        receipt_text: paid ? c.receiptText : null,
        // Deals of the day on the idle screen (P20a): the promotions running now that the store shows.
        deals: s && s.lines.length ? [] : c.deals(),
      };
      lastArgs.current = [s, paid, card];
      lastShown.current = state;
      display.publish(state);
    },
    [display, rt.identity.merchant_name],
  );
  const setLanguage = useCallback(
    (lang: Lang) => {
      ctx.current = { ...ctx.current, language: lang };
      setCustomerLang(lang);
      if (lastShown.current) {
        lastShown.current = { ...lastShown.current, language: lang };
        display.publish(lastShown.current);
      }
    },
    [display],
  );
  /** Re-send what the customer screen shows, after the context changed. */
  const refresh = useCallback(() => {
    if (lastArgs.current) show(...lastArgs.current);
  }, [show]);
  useEffect(
    () =>
      display.onCustomer((m) => {
        if (m.kind === 'customer_language') {
          if (ctx.current.i18n.offered.includes(m.language)) setLanguage(m.language);
          return;
        }
        if (m.purpose === 'receipt') {
          // "Text me my receipt" on the paid screen: the digital-receipt link, online only.
          const done = sesRef.current.state().lastCompleted;
          if (!done?.receipt_token) return;
          void rt.loyalty.textReceipt(done.sale_id, done.receipt_token, m.phone).then(
            (r) => {
              ctx.current.receiptText = r.delivered ? 'sent' : 'not_delivered';
              setReceiptText(ctx.current.receiptText);
              refresh();
            },
            () => {
              ctx.current.receiptText = 'failed';
              setReceiptText('failed');
              refresh();
            },
          );
          return;
        }
        // Rewards: the ticket carries the keyed hash; the balance comes from the server.
        const sale = sesRef.current.state().sale;
        const who = rt.loyalty.identify(m.phone);
        if (!sale || !who || !ctx.current.loyaltySettings) return;
        void (async () => {
          await sesRef.current.identifyCustomer({ ref: who.ref, last4: who.last4, marketing_opt_in: m.marketing_opt_in });
          const base: Cust = { saleId: sale.sale_id, ref: who.ref, last4: who.last4, status: null, offline: false };
          ctx.current.cust = base;
          setCust(base);
          refresh();
          if (m.marketing_opt_in) void rt.loyalty.optIn(who);
          const status = await rt.loyalty.status(who.ref);
          const next = { ...base, status, offline: !status };
          ctx.current.cust = next;
          setCust(next);
          refresh();
        })();
      }),
    [display, setLanguage, rt, refresh],
  );
  // A snapshot that stops offering the current language sends the screen back to the default.
  useEffect(() => {
    if (!i18n.offered.includes(customerLang)) setLanguage(i18n.default);
  }, [i18n, customerLang, setLanguage]);
  useEffect(() => ses.setCompletionContext({ language: customerLang, digital_receipt: digital }), [ses, customerLang, digital]);
  /** The customer screen goes back to idle: the next customer starts in the default language. */
  const showIdle = () => {
    ctx.current = { ...ctx.current, language: ctx.current.i18n.default, cust: null, receiptText: null };
    setCustomerLang(ctx.current.i18n.default);
    setCust(null);
    setReceiptText(null);
    show(null);
  };

  /** True while printing a receipt automatically (after_sale: print): don't pop the preview over the change. */
  const quietPrint = useRef(false);
  const hardware: Hardware = useMemo(
    () =>
      new WebPreviewHardware(
        (lines) => {
          if (quietPrint.current) return;
          const t = tRef.current;
          setModal({ kind: 'receipt', lines, title: t('Receipt (printer preview)') });
        },
        () => {
          setDrawerFlash(true);
          setTimeout(() => setDrawerFlash(false), 1500);
        },
      ),
    [],
  );

  const [drawerSession, setDrawerSession] = useState(rt.drawer.current());
  // Time clock and the hourly ribbon (P15). The clock re-renders each minute while someone is on it.
  const [, setTick] = useState(0);
  useEffect(() => rt.clock.subscribe(() => setTick((t) => t + 1)), [rt]);
  // Stock (P22b): tile badges and sell-soon follow the latest levels.
  useEffect(() => rt.stock.subscribe(() => setTick((t) => t + 1)), [rt]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const [pulse, setPulse] = useState<Awaited<ReturnType<typeof rt.pulse>>>(null);
  useEffect(() => {
    let live = true;
    const load = () => void rt.pulse().then((p) => live && setPulse(p));
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [rt, session.lastCompleted?.sale_id]);
  useEffect(() => rt.drawer.subscribe(setDrawerSession), [rt]);
  const [staff, setStaff] = useState<StaffState>(rt.staff.state());
  useEffect(() => rt.staff.subscribe(setStaff), [rt]);
  useEffect(() => {
    setSession(ses.state());
    return ses.subscribe(setSession);
  }, [ses]);
  useEffect(() => rt.sync.subscribe(setSync), [rt]);
  // A newer catalog (price change, new item, reordered category) replaces the keys in place.
  useEffect(() => rt.sync.onCatalog(setCatalog), [rt]);

  // Customer screen follows the ticket (unless it's showing "thank you").
  useEffect(() => {
    if (modal.kind !== 'done') show(session.sale);
  }, [session.sale, modal.kind, show]);

  const sale = session.sale;
  const ticketTotals = sale ? shownTotals(sale.cash) : null;
  // A return without a receipt (ADR 0051): the items coming back, then a cash refund. No tenders.
  const isReturn = sale?.kind === 'return';
  // Feature flags for this merchant (P12b); an older snapshot without them means everything on.
  const flags = resolveFlags(catalog.flags ?? {});
  const cardOk = sync?.online ?? false;
  const dropNeed = drawerSession ? dropSuggestion(drawerSession.expected_cents, drawerSession.float_cents, catalog.cash_settings?.drop_over_cents ?? 0) : { needed: false, suggest_cents: 0 };
  // Items created here but not yet in a server snapshot are overlaid, so they ring up offline (P5).
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => rt.items.subscribe(() => setPendingCount(rt.items.size())), [rt]);
  // pendingCount is the change signal: the outbox mutates in place, so the memo keys on its size.
  const shown = useMemo(() => rt.items.overlay(catalog), [rt, catalog, pendingCount]);
  const index = useMemo(() => barcodeIndex(shown), [shown]);
  const [query, setQuery] = useState('');
  const [priceCheck, setPriceCheck] = useState(false);
  const favorites = useMemo(() => favoriteKeys(shown), [shown]);
  // Search by name, PLU or barcode (whole or its last digits); each result reads back its code.
  const hits = useMemo(() => (query.trim() ? searchCatalog(shown, query, 40) : null), [shown, query]);
  const results = useMemo(() => hits?.map((h) => h.item) ?? null, [hits]);
  const foundById = useMemo(() => (hits ? new Map(hits.map((h) => [h.item.item_id, { match: h.match, code: h.code, query }])) : null), [hits, query]);
  // Named key pages (ADR 0047): the owner's own tabs, after Favorites.
  const pages = shown.key_pages ?? [];
  const page = category?.startsWith(PAGE) ? (pages.find((p) => PAGE + p.page_id === category) ?? null) : null;
  const pageTiles = useMemo(() => {
    if (!page) return null;
    const byItem = new Map(shown.items.map((i) => [i.item_id, i]));
    const byCat = new Map(shown.categories.map((c) => [c.category_id, c]));
    return page.keys.flatMap((k, n): PageTile[] => {
      if (k.kind === 'item') {
        const item = byItem.get(k.item_id);
        return item && item.active ? [{ kind: 'item' as const, key: `${n}`, item }] : [];
      }
      const cat = byCat.get(k.category_id);
      return cat && cat.active !== false ? [{ kind: 'department' as const, key: `${n}`, cat, amount: k.amount_cents, label: k.label ?? cat.name }] : [];
    });
  }, [page, shown]);
  const items = useMemo(
    () => results ?? (category === FAVORITES ? favorites : page ? [] : categoryKeys(shown, category)),
    [results, shown, category, favorites, page],
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        rt.log.warn('action refused at the register', { message: (e as Error).message.slice(0, 200) });
        setModal({ kind: 'error', message: (e as Error).message });
      }
    },
    [rt],
  );

  /** Run `action` if the signed-in person may; otherwise ask for a manager override first. */
  const guarded = (permission: Permission, saleId: string | null, action: () => Promise<unknown>) => {
    if (rt.staff.can(permission)) void run(action);
    else setModal({ kind: 'override', permission, saleId, then: action });
  };

  /**
   * Ring an item (or price-check it). Quantity intelligence lives in the session: ringing the same
   * item again raises its line. Age checks are skipped only when it merges into an already-checked
   * line; open-price items ask for the price.
   */
  const ring = (item: CatalogItem, opts: { qty?: number; entry: Entry; ageConfirmed?: boolean; idCheck?: { age: number; jurisdiction: string | null }; labelPrice?: number }) => {
    // A count set with @ multiplies the next ring (a case barcode's pack quantity too), then clears.
    const qty = (opts.qty ?? 1) * (atQty ?? 1);
    if (atQty !== null) setAtQty(null);
    if (priceCheck) return setModal({ kind: 'price_check', item, showCost: false });
    // The age check keeps a price already known (a price label, or an amount rung to a department).
    if (item.min_age && !opts.ageConfirmed && !ses.wouldMerge(item) && !isReturn) return setModal({ kind: 'age', item, qty, entry: opts.entry, ...(opts.labelPrice !== undefined ? { labelPrice: opts.labelPrice } : {}) });
    // A price-embedded label (P21) carries the price: no need to ask.
    const price = opts.labelPrice !== undefined ? { cash: cents(opts.labelPrice), card: deriveCardPrice(cents(opts.labelPrice), catalog.dual_price_rate_ppm) } : undefined;
    if (item.open_price && !price) return setModal({ kind: 'open_price', item, qty, entry: opts.entry, ageConfirmed: !!opts.ageConfirmed });
    void run(() => ses.addItem(item, { qty, entry: opts.entry, ageConfirmed: !!opts.ageConfirmed, ...(price ? { price } : {}), ...(opts.idCheck ? { idCheck: opts.idCheck } : {}) }));
  };
  const addItem = (item: CatalogItem) => ring(item, { entry: query ? 'search' : 'key' });
  // Department ring (ADR 0046): the typed amount to the department tab on screen, no item behind it.
  const deptTab = catalog.categories.find((c) => c.category_id === category && c.active !== false) ?? null;
  const deptItem = (id: string | null) => {
    const c = catalog.categories.find((x) => x.category_id === id);
    return c ? departmentItem(c, catalog) : null;
  };
  // @ (ADR 0047): the typed digits become the count for the next item.
  const setAt = () => {
    const n = padQty(pad);
    if (n === null) return setModal({ kind: 'error', message: t('Type how many (1 to 999), then @') });
    setAtQty(n);
    setPad('');
  };
  // PLU (ADR 0047): the typed digits as a PLU (then as a barcode), rung like a scan.
  const ringPlu = () => {
    const digits = pad;
    if (!digits) return;
    setPad('');
    const hit = findByPlu(index, digits, (code) => lookupBarcode(index, code));
    if (!hit) return setModal({ kind: 'error', message: t('No item with PLU {plu}.', { plu: digits }) });
    ring(hit.item, { qty: hit.qty, entry: 'key' });
  };
  const ringDepartment = () => {
    if (!deptTab) return;
    const typed = padCents(pad);
    setPad('');
    ring(departmentItem(deptTab, catalog), { entry: 'key', ...(typed > 0 ? { labelPrice: typed } : {}) });
  };
  // Compliance (P10): bag-fee keys in force today, and each category's effective age check.
  const today = localDate(new Date(), rt.identity.timezone);
  const bagFees = bagFeesOn(catalog.compliance?.charges ?? [], today);
  const catAge = (c: CatalogSnapshot['categories'][number]) => effectiveMinAge(c.min_age, c.restriction ?? null, catalog.compliance?.min_ages ?? null);

  // One-tap baskets (P14): repeat the last sale, or a cashier's "usual".
  const byId = useMemo(() => new Map(shown.items.map((i) => [i.item_id, i])), [shown]);
  const myUsuals = (catalog.usuals ?? []).filter((u) => staff.member && u.user_id === staff.member.user_id);
  const ringAll = (batch: Batch, label: string, ageConfirmed: boolean, idCheck?: { age: number; jurisdiction: string | null }) =>
    void run(async () => {
      if (batch.lines.length === 0)
        throw new Error(
          batch.skipped.length
            ? t('Nothing to ring: {items} not sold any more', { items: batch.skipped.join(', ') })
            : t('Nothing to ring: no items not sold any more'),
        );
      await ringBatch(ses, batch, ageConfirmed, idCheck);
      rt.log.info('batch rung', { label, lines: batch.lines.length, skipped: batch.skipped.length });
      if (batch.skipped.length)
        setModal({ kind: 'error', message: t('Rung {label}. Not rung (not sold any more, or needs a price): {items}.', { label, items: batch.skipped.join(', ') }) });
    });
  const startBatch = (batch: Batch, label: string) => (batch.min_age ? setModal({ kind: 'batch_age', batch, label }) : ringAll(batch, label, false));

  /** While a delivery is being received (P22b), scans go to it instead of the ticket. */
  const receiveScan = useRef<((code: string) => void) | null>(null);
  const registerReceiveScan = useCallback((fn: ((code: string) => void) | null) => {
    receiveScan.current = fn;
  }, []);

  /** A scanned (or typed) barcode: ring it, or offer to add it to the catalog if we don't know it. */
  const onCode = (code: string) => {
    if (receiveScan.current) return receiveScan.current(code);
    const hit = lookupBarcode(index, code);
    if (hit) {
      rt.log.info('scan', { matched: hit.matched, qty: hit.qty });
      ring(hit.item, { qty: hit.qty, entry: 'scan', ...(hit.price_cents !== undefined ? { labelPrice: hit.price_cents } : {}) });
    } else if (priceCheck || !flags.register_item_create) {
      setModal({
        kind: 'error',
        message: priceCheck ? t('Barcode {code} isn’t in the catalog.', { code }) : t('Barcode {code} isn’t in the catalog. Ask the owner to add it.', { code }),
      });
    } else {
      rt.log.info('unknown barcode scanned', { code });
      guarded('item.create', sale?.sale_id ?? null, async () => setModal({ kind: 'unknown', code }));
    }
  };

  // Keyboard-wedge scanner (USB/Bluetooth HID): a fast burst of keys ending in Enter. Captured
  // before the page sees it, so a scan into the search box rings the item instead of searching.
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const modalRef = useRef(modal.kind);
  modalRef.current = modal.kind;
  // ID scan (P16b): a licence barcode arrives as several fast lines. While an age check is open they
  // are collected and parsed after a short pause; only the derived age ever leaves checkId.
  const [idResult, setIdResult] = useState<IdCheck | null>(null);
  const idBuf = useRef('');
  const idTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onIdScan = (raw: string) => {
    const m = modal;
    const minAge = m.kind === 'age' ? (m.item.min_age ?? 0) : m.kind === 'batch_age' ? (m.batch.min_age ?? 0) : 0;
    if (!minAge) return;
    const r = checkId(raw, minAge, localDate(new Date(), rt.identity.timezone));
    rt.log.info('id scanned', { ok: r.ok, flags: r.flags.join(','), age_ok: r.age !== null && r.age >= minAge });
    if (!r.ok) return setIdResult(r);
    const idCheck = { age: r.age!, jurisdiction: r.jurisdiction };
    setIdResult(null);
    setModal({ kind: 'none' });
    if (m.kind === 'age') ring(m.item, { qty: m.qty, entry: m.entry, ageConfirmed: true, idCheck, ...(m.labelPrice !== undefined ? { labelPrice: m.labelPrice } : {}) });
    else if (m.kind === 'batch_age') ringAll(m.batch, m.label, true, idCheck);
  };
  const onIdScanRef = useRef(onIdScan);
  onIdScanRef.current = onIdScan;
  useEffect(() => setIdResult(null), [modal.kind]);
  useEffect(() => {
    if (Platform.OS !== 'web') return; // The Kotlin module delivers scans on the device (P-HW).
    const decoder = new WedgeDecoder();
    const onKey = (e: KeyboardEvent) => {
      const code = decoder.feed(e.key, e.timeStamp || performance.now());
      if (!code) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      if (modalRef.current === 'age' || modalRef.current === 'batch_age') {
        idBuf.current += code + '\n';
        if (idTimer.current) clearTimeout(idTimer.current);
        idTimer.current = setTimeout(() => {
          const raw = idBuf.current;
          idBuf.current = '';
          onIdScanRef.current(raw);
        }, 250);
        return;
      }
      if (modalRef.current === 'none' || modalRef.current === 'price_check') onCodeRef.current(code);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  async function createUnknown(code: string, v: { name: string; cash: number; category_id: string | null }) {
    const cmd = {
      item_id: rt.uuid(),
      name: v.name,
      category_id: v.category_id,
      cash_price_cents: v.cash,
      upc: code,
      created_by_user_id: ses.actorId(),
      created_at: new Date().toISOString(),
    };
    await rt.items.add(cmd);
    rt.log.info('item created at the register', { name: v.name, code });
    setModal({ kind: 'none' });
    ring(pendingItem(catalog, cmd), { entry: 'new_item' });
    rt.sync.kick();
  }

  // Scan-to-attach (ADR 0043): the barcode goes on the item the cashier picked, and it rings now.
  async function attachUnknown(code: string, item: CatalogItem) {
    await rt.items.attach({ attach_id: rt.uuid(), item_id: item.item_id, barcode: code, attached_by_user_id: ses.actorId(), attached_at: new Date().toISOString() });
    rt.log.info('barcode attached at the register', { name: item.name, code });
    setModal({ kind: 'none' });
    ring(item, { entry: 'scan' });
    rt.sync.kick();
  }

  // The location's receipt settings (P8); older cached snapshots have none → the defaults.
  const receiptSettings = catalog.receipt;
  const receiptFor = (s: FoldedSale, copy: 'original' | 'reprint', footer?: string) =>
    renderReceipt({
      header: {
        merchant_name: rt.identity.merchant_name,
        location_name: rt.identity.location_name,
        address_line1: rt.identity.address_line1,
        city_state_zip: [rt.identity.city, [rt.identity.state, rt.identity.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
        register_name: rt.identity.register_name,
      },
      sale: s,
      occurred_at: new Date().toISOString(),
      timezone: rt.identity.timezone,
      copy,
      ...(footer ? { footer } : training ? { footer: '*** TRAINING — NOT A SALE ***' } : {}),
      ...(receiptSettings
        ? { settings: receiptSettings, logo_url: receiptSettings.logo_url ? `${API_URL}${receiptSettings.logo_url}` : null }
        : {}),
      // In the language the customer had at payment (on the sale), with the platform's corrections (P18).
      overrides: i18n.overrides,
      digital_url: s.receipt_token ? receiptUrl(s.receipt_token) : null,
    });

  // Remote actions that need this screen or the printer (P4): reprint any sale rung here, test page, restart.
  useEffect(() => {
    rt.ops.setHandlers({
      reprint: async (saleId) => {
        const events = await rt.store.eventsForSale(saleId);
        if (events.length === 0) throw new Error('That sale is not on this register');
        await hardware.printReceipt(receiptFor(foldSale(saleId, events), 'reprint'));
        await ses.recordReceipt(saleId, 'reprint');
        const t = tRef.current;
        return t('Reprinted ticket {id}', { id: saleId.slice(0, 4).toUpperCase() });
      },
      printerTest: async () => {
        await hardware.printReceipt([
          { text: 'AD PAY — PRINTER TEST', style: 'double' },
          { text: `${rt.identity.merchant_name} · ${rt.identity.register_name}`, style: 'normal' },
          { text: new Date().toLocaleString(), style: 'normal' },
          { text: 'If you can read this, the printer works.', style: 'normal' },
        ]);
        const t = tRef.current;
        return t('Test page printed');
      },
      restartApp: () => {
        if (Platform.OS === 'web') window.location.reload();
        else DevSettings.reload();
      },
    });
    // receiptFor only reads rt, so the handlers stay valid for the life of this screen.
  }, [rt, hardware]);

  /** Cash in hand: open the drawer and record it (full or part payment). */
  async function takeCash(saleId: string) {
    if (training) return; // nothing real happened: no drawer, no event
    await hardware.kickDrawer();
    await ses.recordDrawer('cash_sale', saleId);
    await rt.drawer.refresh();
  }

  // The pad (layout A): a cash tender waiting for the drawer to be started.
  const pendingCash = useRef<{ amount: number; partial: boolean } | null>(null);
  function cashTender(amount: number, partial: boolean) {
    setPad('');
    // Cash needs a started drawer (a counted float), so the day reconciles to the cent.
    if (!training && !rt.drawer.current()) {
      pendingCash.current = { amount, partial };
      setModal({ kind: 'drawer', startWithFloat: true, thenCash: true });
      return;
    }
    void tender(amount, partial);
  }
  function finishPendingCash() {
    const p = pendingCash.current;
    pendingCash.current = null;
    setModal({ kind: 'none' });
    if (p) void tender(p.amount, p.partial);
  }

  async function refundReturn() {
    await run(async () => {
      const r = await ses.completeReturn();
      rt.log.info('return without receipt', { sale: r.sale.sale_id.slice(0, 8), amount_cents: r.amount, lines: r.sale.lines.length });
      if (!training) await hardware.kickDrawer();
      await hardware.printReceipt(receiptFor(r.sale, 'original', `RETURN - ${usd(r.amount)} refunded`));
      await rt.drawer.refresh();
      rt.sync.kick();
      setModal({ kind: 'error', message: t('Refunded {amount} in cash.', { amount: usd(r.amount) }), done: true });
    });
  }

  async function tender(amount: number, partial = false) {
    await run(async () => {
      const saleId = sale!.sale_id;
      const r = await ses.tenderCash(cents(amount), { partial });
      await takeCash(saleId);
      if (!r.completed) {
        // Split: the rest goes on a card at the card price of what's left (ADR 0017).
        rt.log.info('part paid in cash', { sale: saleId.slice(0, 8), cash_cents: amount });
        setModal({ kind: 'card', phase: { kind: 'ready' } });
        return;
      }
      rt.log.info('cash sale completed', { sale: r.sale.sale_id.slice(0, 8), total_cents: r.sale.paid_cents, lines: r.sale.lines.length });
      await completed(r.sale, amount, r.change);
    });
  }

  /**
   * Card: amount to the terminal (the whole card price of what's left by default), then approved /
   * declined / couldn't reach it. A retry reuses the same tender id, so it can never charge twice.
   */
  async function chargeCard(amount?: Cents, retry?: { tender_id: string; amount: Cents }) {
    await run(async () => {
      const current = session.sale!;
      const t = retry ?? (await ses.startCard(amount));
      setModal({ kind: 'card', phase: { kind: 'waiting', amount: t.amount } });
      show(current, undefined, { phase: 'card', amount: t.amount });
      const r = await rt.payments.charge(current.sale_id, t.tender_id, t.amount);
      const res = await ses.finishCard(t.tender_id, t.amount, { ...r, status: r.status });
      rt.log.info('card', { status: r.status, sale: current.sale_id.slice(0, 8), amount_cents: t.amount });
      if (r.status === 'approved') {
        show(res.sale, undefined, { phase: 'approved', amount: t.amount });
        if (res.completed) await completed(res.sale, res.sale.paid_cents, 0);
        else setModal({ kind: 'card', phase: { kind: 'ready' } }); // two cards: the rest
      } else if (r.status === 'declined') {
        show(res.sale, undefined, { phase: 'declined', amount: t.amount });
        setModal({ kind: 'card', phase: { kind: 'declined', message: r.message } });
      } else {
        // The customer sees their cart again, never "system down"; the cashier sees what happened.
        show(res.sale);
        setModal({ kind: 'card', phase: { kind: 'error', message: r.message, retry: t } });
      }
      rt.sync.kick();
    });
  }

  /** Every paid sale ends here: customer screen, after-sale receipt choice, the done screen. */
  async function completed(done: FoldedSale, amount: number, change: number) {
    show(done, { amount, change });
    // After-sale setting (P8): ask; always print; or never print unless asked — the zero-tap sale.
    const after = receiptSettings?.after_sale ?? 'ask';
    let printed: readonly ReceiptLine[] | null = null;
    if (after === 'print') {
      printed = receiptFor(done, 'original');
      quietPrint.current = true;
      try {
        await hardware.printReceipt(printed);
      } finally {
        quietPrint.current = false;
      }
      await ses.recordReceipt(done.sale_id, 'original');
    } else if (after === 'none') {
      await ses.recordReceipt(done.sale_id, 'none');
    }
    setModal({ kind: 'done', sale: done, change, after, printed });
    rt.sync.kick();
  }

  async function finishReceipt(done: FoldedSale, print: boolean) {
    await run(async () => {
      if (print) await hardware.printReceipt(receiptFor(done, 'original'));
      else setModal({ kind: 'none' });
      await ses.recordReceipt(done.sale_id, print ? 'original' : 'none');
      showIdle();
      rt.sync.kick();
    });
  }

  async function reprintLast() {
    await run(async () => {
      const events = await ses.lastSaleEvents();
      const last = session.lastCompleted;
      if (!last || events.length === 0) throw new Error(t('No completed sale on this register yet'));
      await hardware.printReceipt(receiptFor(foldSale(last.sale_id, events), 'reprint'));
      await ses.recordReceipt(last.sale_id, 'reprint');
      rt.sync.kick();
    });
  }

  function openCustomerScreen() {
    if (Platform.OS === 'web') window.open('/?display=customer', 'adpay-customer', 'width=1024,height=640');
  }

  // Nobody signed in (and this store uses PINs): the counter shows "who's working?" and nothing else.
  // Signing in starts the shift (tester feedback: one action, not two); already on the clock, nothing changes.
  if (staff.required && !staff.member)
    return (
      <SignInScreen
        gate={rt.staff}
        storeName={`${rt.identity.merchant_name} · ${rt.identity.location_name}`}
        onSignedIn={async (userId) => {
          if (!rt.clock.since(userId)) await rt.clock.clockIn(userId);
        }}
      />
    );

  return (
    <View style={{ flex: 1 }}>
      <View style={s.topbar}>
        <Text style={s.topBrand}>
          <Text style={s.mark}> AD </Text> Pay
        </Text>
        <Text style={s.topWhere} numberOfLines={1}>
          {rt.identity.merchant_name} · {rt.identity.location_name} · {rt.identity.register_name}
        </Text>
        {pulse && pulse.today_cents > 0 ? (
          // Hourly target ribbon (Bible 1.10): where today is against yesterday by this time. Up is green; down stays white.
          <Text style={s.ribbon} numberOfLines={1}>
            {t('Today {today} · yesterday by now {yesterday}', { today: usd(pulse.today_cents), yesterday: usd(pulse.yesterday_cents) })}
            {pulse.vs_yesterday_tenths !== null ? <Text style={pulse.vs_yesterday_tenths > 0 ? s.ribbonUp : undefined}> {pctChangeText(pulse.vs_yesterday_tenths)}</Text> : null}
          </Text>
        ) : null}
        {staff.member ? (
          // Clock out ends the shift and signs out in one tap; Lock hands the register over and keeps the shift running.
          <Pressable
            onPress={() => {
              const m = staff.member!;
              void run(async () => {
                if (!rt.clock.since(m.user_id)) return rt.clock.clockIn(m.user_id);
                await rt.clock.clockOut(m.user_id);
                await rt.staff.signOut('manual');
              });
            }}
            style={[s.who, rt.clock.since(staff.member.user_id) ? s.onClock : null]}
            accessibilityLabel={rt.clock.since(staff.member.user_id) ? t('Clock out and sign out') : t('Clock in')}
          >
            <Text style={s.whoText}>
              {rt.clock.since(staff.member.user_id) ? t('Clock out · {time}', { time: hhmm(rt.clock.minutes(staff.member.user_id)) }) : t('Clock in')}
            </Text>
          </Pressable>
        ) : null}
        {staff.member ? (
          <Pressable onPress={() => void run(() => rt.staff.signOut('manual'))} style={s.who} accessibilityLabel={t('Signed in as {name}. Tap to lock.', { name: staff.member.name })}>
            <Text style={s.whoText}>{staff.member.name.split(' ')[0]}</Text>
            <Text style={s.whoLock}>{t('Lock')}</Text>
          </Pressable>
        ) : (
          <View style={[s.pill, s.pillWarn]}>
            <Text style={[s.pillText, { color: C.amber }]}>{t('No staff PINs set up')}</Text>
          </View>
        )}
        <Pressable onPress={() => setModal({ kind: 'drawer', startWithFloat: false, thenCash: false })} style={[s.pill, drawerSession ? s.pillDark : s.pillWarn]}>
          <Text style={[s.pillText, { color: drawerSession ? '#fff' : C.amber }]}>{drawerSession ? t('Drawer') : t('Drawer not started')}</Text>
        </Pressable>
        <SyncPill status={sync} onPress={() => setModal({ kind: 'device' })} />
        {/* The cashier's own language (P18b), independent of the customer screen. */}
        <LanguageButton dark />
        {Platform.OS === 'web' ? (
          <Pressable onPress={openCustomerScreen}>
            <Text style={s.topLink}>{t('Customer screen ↗')}</Text>
          </Pressable>
        ) : null}
      </View>
      {drawerFlash ? (
        <View style={s.drawerFlash}>
          <Text style={s.drawerText}>{t('Drawer opened')}</Text>
        </View>
      ) : null}

      <View style={s.body}>
        <View style={{ flex: 1 }}>
          {/* Departments as tabs across the top (layout A, ADR 0045). */}
          <ScrollView horizontal style={s.deptBar} contentContainerStyle={s.deptRow} showsHorizontalScrollIndicator={false}>
            {favorites.length > 0 ? (
              <Pressable onPress={() => setCategory(FAVORITES)} style={[s.dept, category === FAVORITES && s.catActive]}>
                <Text style={[s.catText, category === FAVORITES && { color: '#fff' }]}>{t('★ Favorites')}</Text>
              </Pressable>
            ) : null}
            {pages.map((p) => (
              <Pressable key={p.page_id} onPress={() => setCategory(PAGE + p.page_id)} style={[s.dept, s.pageTab, category === PAGE + p.page_id && s.catActive]}>
                <Text style={[s.catText, category === PAGE + p.page_id && { color: '#fff' }]}>{p.name}</Text>
              </Pressable>
            ))}
            {pages.length ? <View style={s.tabGap} /> : null}
            {catalog.categories.filter((c) => c.active !== false).map((c) => (
              <Pressable key={c.category_id} onPress={() => setCategory(c.category_id)} style={[s.dept, category === c.category_id && s.catActive]}>
                <Text style={[s.catText, category === c.category_id && { color: '#fff' }]}>{c.name}</Text>
                {catAge(c) ? <Text style={[s.catAge, category === c.category_id && { color: '#ddd' }]}>{catAge(c)}+</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
          <View style={s.searchRow}>
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder={t('Search name, UPC or PLU — or scan')}
              autoCorrect={false}
              onSubmitEditing={() => {
                const q = query.trim();
                if (!q) return;
                if (/^\d{3,}$/.test(q) && lookupBarcode(index, q)) {
                  setQuery('');
                  onCode(q);
                } else if (results?.length === 1) {
                  setQuery('');
                  ring(results[0]!, { entry: 'search' });
                } else if (/^\d{6,}$/.test(q) && !results?.length) {
                  setQuery('');
                  onCode(q);
                }
              }}
              accessibilityLabel={t('Search items')}
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} style={s.clear} accessibilityLabel={t('Clear search')}>
                <Text style={s.clearText}>×</Text>
              </Pressable>
            ) : null}
          </View>
          {priceCheck ? (
            <View style={s.checkBanner}>
              <Text style={s.checkText}>{t('Price check — scan or tap an item to see its prices. Nothing is rung up.')}</Text>
              <Pressable onPress={() => setPriceCheck(false)}>
                <Text style={s.checkText}>{t('Done')}</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.grid} keyboardShouldPersistTaps="handled">
            {!results && pageTiles
              ? pageTiles.map((k) =>
                  k.kind === 'item' ? (
                    <QuickKey key={k.key} item={k.item} badge={rt.stock.badge(k.item)} onPress={addItem} onLongPress={(it) => setModal({ kind: 'add_qty', item: it, entry: 'key' })} />
                  ) : (
                    <AmountKey
                      key={k.key}
                      label={k.label}
                      department={k.cat.name}
                      amount={k.amount}
                      cardAmount={k.amount !== null ? deriveCardPrice(cents(k.amount), catalog.dual_price_rate_ppm) : null}
                      onPress={() => ring(departmentItem(k.cat, catalog), { entry: 'key', ...(k.amount !== null ? { labelPrice: k.amount } : {}) })}
                    />
                  ),
                )
              : null}
            {items.map((i) => (
              <QuickKey key={i.item_id} item={i} badge={rt.stock.badge(i)} found={foundById?.get(i.item_id) ?? null} onPress={addItem} onLongPress={(it) => setModal({ kind: 'add_qty', item: it, entry: query ? 'search' : 'key' })} />
            ))}
            {results && results.length === 0 ? (
              <Text style={s.mutedSmall}>
                {/^\d{6,}$/.test(query.trim())
                  ? t('Nothing matches “{query}”. Press Enter to add it as a new item.', { query })
                  : t('Nothing matches “{query}”.', { query })}
              </Text>
            ) : null}
          </ScrollView>
          <RegisterPad
            digits={pad}
            onDigits={setPad}
            dueCash={sale?.remaining_cash_cents ?? 0}
            dueCard={sale ? cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents) : 0}
            canTender={!!sale?.lines.length && !isReturn}
            cardShown={flags.card_payments && !training}
            cardOk={cardOk}
            allowPart={cardOk && flags.card_payments && !training}
            onCash={(amount, partial) => cashTender(amount, partial)}
            onCard={(amount) => {
              setPad('');
              void chargeCard(amount);
            }}
            onRejectBill={() => setModal({ kind: 'drawer', startWithFloat: false, thenCash: false, counterfeit: true })}
            onOther={() => setModal({ kind: 'other_tender' })}
            pendingQty={atQty}
            extraKeys={
              <>
                <PadKey label="@" sub={atQty ? t('{count} ×', { count: atQty }) : t('quantity')} onPress={setAt} disabled={!pad} accessibilityLabel={t('Quantity: the typed number times the next item')} />
                <PadKey label="PLU" sub={pad ? `#${pad}` : t('code')} onPress={ringPlu} disabled={!pad} accessibilityLabel={t('Ring the item with the typed PLU')} />
                <DepartmentKey dept={deptTab} typed={padCents(pad)} onPress={ringDepartment} />
              </>
            }
          />
        </View>

        <View style={s.ticket}>
          <Text style={s.ticketTitle}>
            {sale ? t('Ticket {id}', { id: sale.sale_id.slice(0, 4).toUpperCase() }) : t('New ticket')}
            {/* The customer chose a language on their screen (P18): the cashier knows, and the receipt follows. */}
            {customerLang !== 'en' ? ` · ${t('Customer: {language}', { language: languageInfo(customerLang).name })}` : ''}
          </Text>
          {/* Loyalty (P19a): the customer typed their number on their screen. A reward needs the server's balance. */}
          {sale?.customer && loyaltySettings ? (
            <View style={s.loyaltyRow} accessible accessibilityLabel={t('Rewards customer, phone ending {last4}', { last4: sale.customer.last4 })}>
              <Text style={s.loyaltyText}>
                {t('Rewards ···{last4}', { last4: sale.customer.last4 })}
                {sale.loyalty
                  ? ` · ${t('reward applied')}`
                  : cust?.saleId === sale.sale_id && cust.status
                    ? ` · ${cust.status.kind === 'visits' ? t('{balance}/{needed} visits', { balance: cust.status.balance, needed: cust.status.needed }) : t('{balance} points', { balance: cust.status.balance })}`
                    : cust?.saleId === sale.sale_id && cust.offline
                      ? ` · ${t('offline: this visit counts, rewards need a connection')}`
                      : ''}
              </Text>
              {!sale.loyalty && cust?.saleId === sale.sale_id && cust.status && cust.status.rewards_available > 0 ? (
                <Pressable
                  style={s.rewardButton}
                  onPress={() => guarded('loyalty.redeem', sale.sale_id, () => ses.redeemLoyalty(loyaltySettings))}
                  accessibilityRole="button"
                >
                  <Text style={s.rewardButtonText}>{t('Apply reward')}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView style={{ flex: 1 }}>
            {!sale || sale.lines.length === 0 ? (
              <>
                <Text style={s.mutedSmall}>{t('Tap an item to start a sale.')}</Text>
                {/* Sell-by alerts for the cashier between customers (Bible 1.9, P22b). */}
                {rt.stock.expiring().slice(0, 4).map((x) => (
                  <Text key={x.item_id + x.expires_on} style={s.sellSoon}>
                    {t('Sell soon: {name} ({qty}) by {date}', { name: x.name, qty: x.qty, date: x.expires_on })}
                  </Text>
                ))}
              </>
            ) : (
              sale.lines.map((l) => (
                <Pressable
                  key={l.line_id}
                  style={s.line}
                  onLongPress={() => setModal({ kind: 'set_qty', line_id: l.line_id, name: l.name, qty: l.qty })}
                  delayLongPress={450}
                  accessibilityHint={t('Long-press to change the quantity')}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.lineName}>
                      {l.qty > 1 ? `${l.qty} × ` : ''}
                      {l.name}
                    </Text>
                    <Text style={s.mutedSmall}>
                      {t('card {amount}', { amount: usd(lineAmount(l, 'card')) })}
                      {l.charges.map((c) => ` · ${t('incl. {label}', { label: c.label })}`).join('')}
                      {l.min_age ? ` · ${t('{age}+ checked', { age: l.min_age })}` : ''}
                      {!l.taxable ? ` · ${t('no tax')}` : ''}
                    </Text>
                    {/* A promotion or reward on this line (P20a): what it was and what it took off. */}
                    {l.cash_discount_cents > 0 ? (
                      <Text style={s.lineDeal}>
                        {l.discount_promo_id && l.discount_reason ? l.discount_reason.replace(/^Promo: /, '') : l.discount_reason === 'Loyalty reward' ? t('reward applied') : t('Discount')} −{usd(l.cash_discount_cents)}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={s.lineAmt}>{usd(lineAmount(l, 'cash'))}</Text>
                  <Pressable onPress={() => void run(() => ses.removeLine(l.line_id))} style={s.remove} accessibilityLabel={t('Remove {name}', { name: l.name })}>
                    <Text style={s.removeText}>×</Text>
                  </Pressable>
                </Pressable>
              ))
            )}
          </ScrollView>
          <View style={s.totals}>
            {/* Items at their marked prices; tax already inside a price isn't added again (ADR 0044). */}
            {isReturn ? (
              <View style={s.returnBanner}>
                <Text style={s.returnText}>{t('RETURN — no receipt')}{sale?.return_reason ? ` · ${sale.return_reason}` : ''}</Text>
                <Text style={s.returnSub}>{t('Ring what is coming back: it is refunded at today’s price, in cash.')}</Text>
              </View>
            ) : null}
            {sale?.basket ? <Row label={t('Ticket discount')} value={-sale.basket.cash_cents} /> : null}
            <Row label={t('Subtotal')} value={ticketTotals?.items_cents ?? 0} />
            <Row label={sale?.tax_exempt ? t('Tax (tax-free: {why})', { why: t(TAX_EXEMPT_LABEL[(sale.tax_exempt.reason ?? 'other') as keyof typeof TAX_EXEMPT_LABEL]) }) : t('Tax')} value={ticketTotals?.added_tax_cents ?? 0} />
            {ticketTotals && ticketTotals.included_tax_cents > 0 ? <Row label={t('Tax included in prices')} value={ticketTotals.included_tax_cents} /> : null}
            <View style={s.dual}>
              <View style={s.dualBox}>
                <Text style={s.dualLabel}>{t('Cash')}</Text>
                <Text style={s.dualValue}>{usd(sale?.cash.total_cents ?? 0)}</Text>
              </View>
              <View style={s.dualBox}>
                <Text style={s.dualLabel}>{t('Card')}</Text>
                <Text style={s.dualValue}>{usd(sale?.card.total_cents ?? 0)}</Text>
              </View>
            </View>
            {isReturn ? (
              // Black, not red: it carries an amount.
              <Pressable style={[s.refundBtn, !sale?.lines.length && s.disabled]} disabled={!sale?.lines.length} onPress={() => void refundReturn()}>
                <Text style={s.refundText}>{t('Refund {amount} in cash', { amount: usd(sale?.cash.total_cents ?? 0) })}</Text>
              </Pressable>
            ) : null}
            {sale && sale.tenders.some((t) => t.approved) ? (
              <View style={s.partPaid}>
                <Text style={s.partPaidText}>
                  {t('Paid so far {paid} · left {cash} cash or {card} card', {
                    paid: usd(sale.paid_cents),
                    cash: usd(sale.remaining_cash_cents),
                    card: usd(cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents)),
                  })}
                </Text>
              </View>
            ) : null}
            {training ? (
              <View style={s.trainingBanner}>
                <Text style={s.trainingText}>{t('TRAINING — practice only. Nothing is saved, synced or charged; receipts say TRAINING.')}</Text>
              </View>
            ) : null}
            {dropNeed.needed && !training ? (
              // Bible 1.2: "drawer over $600, drop now", on the cashier's screen only, never the customer's.
              <Pressable style={s.dropBanner} onPress={() => setModal({ kind: 'drawer', startWithFloat: false, thenCash: false })}>
                <Text style={s.dropText}>
                  {t('Drawer is over {limit}. Drop about {amount} to the safe now.', {
                    limit: usd(catalog.cash_settings?.drop_over_cents ?? 0),
                    amount: usd(dropNeed.suggest_cents),
                  })}
                </Text>
              </Pressable>
            ) : null}
            {flags.card_payments && !cardOk && sale?.lines.length ? (
              // Bible 1.7: when the card path is down, say so plainly and keep selling for cash.
              <Pressable style={s.cashOnly} onPress={() => rt.sync.kick()}>
                <Text style={s.cashOnlyText}>{t('Cash only right now — no connection to the card machine. Tap to retry.')}</Text>
              </Pressable>
            ) : null}
            {session.lastCompleted || myUsuals.length || (sale?.lines.length && staff.member) ? (
              <View style={s.actions}>
                {session.lastCompleted && !sale?.lines.length ? (
                  <Pressable style={s.ghost} onPress={() => startBatch(repeatBatch(session.lastCompleted!, byId, deptItem), t('the last sale'))} accessibilityLabel={t('Repeat the last sale')}>
                    <Text>{t('↻ Repeat last')}</Text>
                  </Pressable>
                ) : null}
                {myUsuals.map((u) => (
                  <Pressable
                    key={u.usual_id}
                    style={s.ghost}
                    onPress={() => startBatch(usualBatch(u, byId), u.label)}
                    onLongPress={() => setModal({ kind: 'remove_usual', usual: u })}
                    delayLongPress={600}
                    accessibilityHint={t('Long-press to remove')}
                  >
                    <Text>★ {u.label}</Text>
                  </Pressable>
                ))}
                {sale?.lines.some((l) => !l.is_fee && !l.is_department) && staff.member && !training ? (
                  <Pressable style={[s.ghost, !cardOk && s.disabled]} disabled={!cardOk} onPress={() => setModal({ kind: 'save_usual' })}>
                    <Text>{t('+ Save as usual')}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {bagFees.length ? (
              // Bag fees in force today (P10): one tap adds a bag; tap again for another.
              <View style={s.actions}>
                {bagFees.map((r) => (
                  <Pressable
                    key={r.rule_id}
                    style={s.ghost}
                    onPress={() => void run(() => ses.addItem(feeItem(r, catalog.tax_rate_ppm), { entry: 'key', fee: true }))}
                    accessibilityLabel={t('Add {label}', { label: r.label })}
                  >
                    <Text>+ {r.label} {usd(cents(r.amount_cents ?? 0))}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </View>
      {/* Shortcut bar underneath (layout A, ADR 0045). */}
      <View style={s.shortcutBar}>
        <Pressable
          style={[s.ghost, !sale && s.disabled]}
          disabled={!sale}
          onPress={() => sale && guarded('ticket.void', sale.sale_id, () => ses.voidSale('Voided at register'))}
        >
          <Text>{t('Void ticket')}</Text>
        </Pressable>
        <Pressable style={[s.ghost, !session.lastCompleted && s.disabled]} disabled={!session.lastCompleted} onPress={() => void reprintLast()}>
          <Text>{t('Reprint last')}</Text>
        </Pressable>
        {flags.hold_tickets ? (
          <Pressable style={[s.ghost, !sale?.lines.length && s.disabled]} disabled={!sale?.lines.length} onPress={() => void run(() => ses.hold())}>
            <Text>{t('Hold')}</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.ghost, !sale?.lines.length && s.disabled, sale?.basket && s.ghostOn]} disabled={!sale?.lines.length} onPress={() => setModal({ kind: 'basket' })}>
          <Text style={sale?.basket ? { color: '#fff' } : undefined}>{sale?.basket ? t('Discount on') : t('Discount')}</Text>
        </Pressable>
        {!training ? (
          <Pressable style={[s.ghost, isReturn && s.ghostOn, !!sale?.lines.length && !isReturn && s.disabled]} disabled={!!sale?.lines.length && !isReturn} onPress={() => setModal({ kind: 'return_start' })}>
            <Text style={isReturn ? { color: '#fff' } : undefined}>{t('Return (no receipt)')}</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.ghost, !sale?.lines.length && s.disabled, sale?.tax_exempt && s.ghostOn]} disabled={!sale?.lines.length} onPress={() => setModal({ kind: 'tax_free' })}>
          <Text style={sale?.tax_exempt ? { color: '#fff' } : undefined}>{t('Tax-free')}</Text>
        </Pressable>
        {session.parked.length ? (
          <Pressable style={[s.ghost, s.ghostOn]} onPress={() => setModal({ kind: 'held' })}>
            <Text style={{ color: '#fff' }}>{t('Held ({count})', { count: session.parked.length })}</Text>
          </Pressable>
        ) : null}
        {!training ? (
          // Refunds and voids move real money: not from training mode.
          <Pressable style={s.ghost} onPress={() => setModal({ kind: 'tickets' })}>
            <Text>{t('Tickets')}</Text>
          </Pressable>
        ) : null}
        {flags.price_check ? (
          <Pressable style={[s.ghost, priceCheck && s.ghostOn]} onPress={() => setPriceCheck((v) => !v)}>
            <Text style={priceCheck ? { color: '#fff' } : undefined}>{t('Price check')}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[s.ghost, training && s.ghostOn]}
          onPress={() =>
            void run(async () => {
              // Leaving training throws the practice ticket away; nothing was ever saved.
              if (training && rt.training.state().sale) await rt.training.voidSale('Training');
              setTraining((t) => !t);
            })
          }
        >
          <Text style={training ? { color: '#fff' } : undefined}>{training ? t('Exit training') : t('Training')}</Text>
        </Pressable>
        {!training ? (
          <>
            <Pressable style={s.ghost} onPress={() => guarded('inventory.receive', null, async () => setModal({ kind: 'receive' }))}>
              <Text>{t('Receive')}</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={() => guarded('inventory.write_off', null, async () => setModal({ kind: 'write_off' }))}>
              <Text>{t('Write off')}</Text>
            </Pressable>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'checklist' })}>
              <Text>{t('Checklist')}</Text>
            </Pressable>
          </>
        ) : null}
        {!training ? (
          <Pressable
            style={s.ghost}
            onPress={() => void run(async () => setModal({ kind: 'eod', z: await rt.eod.preview(catalog), lines: null, done: false }))}
          >
            <Text>{t('End of day')}</Text>
          </Pressable>
        ) : null}
      </View>

      {modal.kind === 'eod' && modal.z && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{modal.done ? t('Z-report #{number} taken', { number: modal.z.z_number }) : t('End of day')}</Text>
          {!modal.done ? (
            <Text style={s.modalBody}>
              {t('Since the last Z: {sales} sales, {gross} (cash {cash}, card {card}), tax {tax}.', {
                sales: modal.z.sales_count,
                gross: usd(modal.z.gross_cents),
                cash: usd(modal.z.by_tender.cash_cents),
                card: usd(modal.z.by_tender.card_cents),
                tax: usd(modal.z.tax_cents),
              })}
              {drawerSession ? ` ${t('Close and count the drawer first: the count is part of the Z.')}` : ''}
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 360 }}>
              {(modal.lines ?? []).map((l, i) => (
                <Text key={i} style={s.zLine}>
                  {l}
                </Text>
              ))}
            </ScrollView>
          )}
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'none' })}>
              <Text>{modal.done ? t('Done') : t('Not now')}</Text>
            </Pressable>
            {!modal.done && drawerSession ? (
              <Pressable style={s.ghost} onPress={() => setModal({ kind: 'drawer', startWithFloat: false, thenCash: false })}>
                <Text>{t('Count the drawer')}</Text>
              </Pressable>
            ) : null}
            {!modal.done ? (
              <Pressable
                style={[s.primary, !!drawerSession && s.disabled]}
                disabled={!!drawerSession}
                onPress={() =>
                  void run(async () => {
                    const z = await rt.eod.close(catalog);
                    const lines = renderZReport(z, { merchant_name: rt.identity.merchant_name, location_name: rt.identity.location_name, register_name: rt.identity.register_name, timezone: rt.identity.timezone });
                    await hardware.printReceipt(lines.map((text) => ({ text, style: 'normal' as const })));
                    rt.sync.kick();
                    setModal({ kind: 'eod', z, lines, done: true });
                  })
                }
              >
                <Text style={s.primaryText}>{t('Take Z & print')}</Text>
              </Pressable>
            ) : null}
          </View>
        </Overlay>
      )}

      {modal.kind === 'batch_age' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{t('Check ID — {age}+', { age: modal.batch.min_age ?? '' })}</Text>
          <Text style={s.modalBody}>
            {t('{label} includes age-restricted items. Scan their ID, or confirm they are {age} or older.', { label: modal.label, age: modal.batch.min_age ?? '' })}
          </Text>
          {idResult ? <Text style={s.idWarn}>{idResult.flags.map((f) => ID_FLAG_TEXT[f]).join(' ')}</Text> : null}
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'none' })}>
              <Text>{t('Not verified')}</Text>
            </Pressable>
            <Pressable
              style={[s.primary, !!idResult && (idResult.flags.includes('under_age') || idResult.flags.includes('expired')) && s.disabled]}
              disabled={!!idResult && (idResult.flags.includes('under_age') || idResult.flags.includes('expired'))}
              onPress={() => {
                const { batch, label } = modal;
                setModal({ kind: 'none' });
                ringAll(batch, label, true);
              }}
            >
              <Text style={s.primaryText}>{t('ID checked — {age}+', { age: modal.batch.min_age ?? '' })}</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'return_start' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <ReturnStartPanel
            onCancel={() => setModal({ kind: 'none' })}
            onStart={(reason) => {
              setModal({ kind: 'none' });
              guarded('refund.no_receipt', null, () => ses.startReturn(reason));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'other_tender' && sale && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <OtherTenderPanel
            due={sale.remaining_cash_cents}
            typedCents={padCents(pad)}
            onCancel={() => setModal({ kind: 'none' })}
            onTake={(x) => {
              setModal({ kind: 'none' });
              setPad('');
              void run(async () => {
                const saleId = sale.sale_id;
                const r = await ses.tenderOther(x.kind, x.amount, { reference: x.reference, other_kind: x.other_kind });
                // A check goes in the drawer; EBT, gift cards and accounts don't.
                if (x.kind === 'check') await takeCash(saleId);
                rt.log.info('other tender', { sale: saleId.slice(0, 8), kind: x.other_kind ?? x.kind, amount_cents: x.amount, completed: r.completed });
                if (r.completed) await completed(r.sale, x.amount, 0);
              });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'tax_free' && sale && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <TaxFreePanel
            sale={sale}
            onCancel={() => setModal({ kind: 'none' })}
            onRemove={() => {
              setModal({ kind: 'none' });
              guarded('ticket.tax_exempt', sale.sale_id, () => ses.setTaxExempt(null));
            }}
            onApply={(x) => {
              setModal({ kind: 'none' });
              guarded('ticket.tax_exempt', sale.sale_id, () => ses.setTaxExempt(x));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'basket' && sale && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <BasketPanel
            sale={sale}
            typedCents={padCents(pad)}
            onCancel={() => setModal({ kind: 'none' })}
            onRemove={() => {
              setModal({ kind: 'none' });
              guarded('ticket.discount', sale.sale_id, () => ses.discountTicket(null));
            }}
            onApply={(d) => {
              setModal({ kind: 'none' });
              if (d.kind === 'amount') setPad('');
              guarded('ticket.discount', sale.sale_id, () => ses.discountTicket(d));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'save_usual' && sale && staff.member && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <SaveUsual
            suggestion={sale.lines.filter((l) => !l.is_fee).map((l) => l.name.split(' ')[0]).slice(0, 3).join(' + ')}
            onCancel={() => setModal({ kind: 'none' })}
            onSave={(label) => {
              const member = staff.member!;
              void run(async () => {
                await rt.usuals.save({ user_id: member.user_id, label, lines: usualLinesFrom(sale) });
                setModal({ kind: 'none' });
              });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'remove_usual' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{t('Remove “{label}”?', { label: modal.usual.label })}</Text>
          <Text style={s.modalBody}>{t('It disappears from every register within a few seconds. Sales already rung are not affected.')}</Text>
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'none' })}>
              <Text>{t('Keep')}</Text>
            </Pressable>
            <Pressable
              style={s.primary}
              onPress={() => {
                const id = modal.usual.usual_id;
                void run(async () => {
                  await rt.usuals.remove(id);
                  setModal({ kind: 'none' });
                });
              }}
            >
              <Text style={s.primaryText}>{t('Remove')}</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'age' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{t('Check ID — {age}+', { age: modal.item.min_age ?? '' })}</Text>
          <Text style={s.modalBody}>
            {t('{name} is age-restricted. Scan the back of their ID, or check it by eye and confirm they are {age} or older.', {
              name: modal.item.name,
              age: modal.item.min_age ?? '',
            })}
          </Text>
          {idResult ? <Text style={s.idWarn}>{idResult.flags.map((f) => ID_FLAG_TEXT[f]).join(' ')}</Text> : null}
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'none' })}>
              <Text>{t('Not verified')}</Text>
            </Pressable>
            <Pressable
              style={[s.primary, !!idResult && (idResult.flags.includes('under_age') || idResult.flags.includes('expired')) && s.disabled]}
              disabled={!!idResult && (idResult.flags.includes('under_age') || idResult.flags.includes('expired'))}
              onPress={() => {
                const { item, qty, entry, labelPrice } = modal;
                setModal({ kind: 'none' });
                ring(item, { qty, entry, ageConfirmed: true, ...(labelPrice !== undefined ? { labelPrice } : {}) });
              }}
            >
              <Text style={s.primaryText}>{t('ID checked — {age}+', { age: modal.item.min_age ?? '' })}</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'card' && sale && (
        <Overlay onClose={modal.phase.kind === 'waiting' ? undefined : () => setModal({ kind: 'none' })}>
          <CardPanel
            sale={sale}
            phase={modal.phase}
            onCharge={(amt) => void chargeCard(amt)}
            onRetry={(pending) => void chargeCard(undefined, pending)}
            onPartial={() => setModal({ kind: 'card', phase: { kind: 'partial' } })}
            onCash={() => {
              // Cash for the rest: back to the pad, which shows what's left.
              show(sale);
              setModal({ kind: 'none' });
            }}
            onBack={() => {
              show(sale);
              setModal({ kind: 'none' });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'done' && (
        <Overlay>
          <Text style={s.modalTitle}>{t('Sale complete')}</Text>
          {/* Change only when cash was handed over; an all-card sale has none to give. */}
          {modal.sale.price_mode !== 'card' ? (
            <>
              <Text style={s.changeLabel}>{t('Change due')}</Text>
              <Text style={s.changeValue}>{usd(modal.change)}</Text>
            </>
          ) : null}
          <Text style={s.modalBody}>
            {modal.sale.price_mode === 'card'
              ? modal.sale.tenders.find((x) => x.card)?.card?.last4
                ? t('Paid {amount} by card ···· {digits}', { amount: usd(modal.sale.paid_cents), digits: modal.sale.tenders.find((x) => x.card)!.card!.last4 ?? '' })
                : t('Paid {amount} by card', { amount: usd(modal.sale.paid_cents) })
              : modal.sale.price_mode === 'split'
                ? t('Paid {amount}: {tenders}', {
                    amount: usd(modal.sale.paid_cents),
                    tenders: modal.sale.tenders
                      .filter((x) => x.approved)
                      .map((x) => `${usd(x.amount_cents)} ${x.tender_type}`)
                      .join(' + '),
                  })
                : t('Total {amount} cash · drawer opened', { amount: usd(modal.sale.cash.total_cents) })}
            {modal.after === 'print' ? ` · ${t('receipt printed')}` : ''}
            {modal.sale.language ? ` · ${t('receipt in {language}', { language: languageInfo(modal.sale.language).name })}` : ''}
          </Text>
          {modal.after === 'ask' ? (
            <View style={s.actions}>
              <Pressable style={s.ghost} onPress={() => void finishReceipt(modal.sale, false)}>
                <Text>{t('No receipt')}</Text>
              </Pressable>
              <Pressable style={s.primary} onPress={() => void finishReceipt(modal.sale, true)}>
                <Text style={s.primaryText}>{t('Print receipt')}</Text>
              </Pressable>
            </View>
          ) : (
            <AutoNext
              key={modal.sale.sale_id}
              onNext={() => {
                setModal({ kind: 'none' });
                showIdle();
              }}
              extra={
                modal.after === 'none' ? (
                  <Pressable
                    style={s.ghost}
                    onPress={() =>
                      void run(async () => {
                        await hardware.printReceipt(receiptFor(modal.sale, 'reprint'));
                        await ses.recordReceipt(modal.sale.sale_id, 'reprint');
                        showIdle();
                      })
                    }
                  >
                    <Text>{t('Print receipt')}</Text>
                  </Pressable>
                ) : modal.printed ? (
                  <Pressable style={s.ghost} onPress={() => setModal({ kind: 'receipt', lines: modal.printed!, title: t('Receipt (printer preview)') })}>
                    <Text>{t('See receipt')}</Text>
                  </Pressable>
                ) : null
              }
            />
          )}
        </Overlay>
      )}

      {modal.kind === 'receive' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <ReceivePanel
            rt={rt}
            catalog={shown}
            index={index}
            registerScan={registerReceiveScan}
            onDone={(message) => {
              setModal(message ? { kind: 'error', message, done: true } : { kind: 'none' });
              void rt.stock.refresh();
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'checklist' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <ChecklistPanel rt={rt} catalog={catalog} uploadPhoto={cardOk ? rt.uploadPhoto : null} onDone={(message) => setModal(message ? { kind: 'error', message, done: true } : { kind: 'none' })} />
        </Overlay>
      )}

      {modal.kind === 'write_off' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <WriteOffPanel
            rt={rt}
            catalog={shown}
            onDone={(message) => {
              setModal(message ? { kind: 'error', message, done: true } : { kind: 'none' });
              void rt.stock.refresh();
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'receipt' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{modal.title}</Text>
          <ScrollView style={s.paper}>
            {modal.lines.map((l, i) =>
              l.style === 'logo' ? (
                <Image key={i} source={{ uri: l.url }} style={s.paperLogo} resizeMode="contain" accessibilityLabel={t('Store logo')} />
              ) : l.style === 'qr' ? (
                // The printer module prints it with ESC/POS's native QR command; the preview draws the same code.
                <View key={i} style={s.paperQr}>
                  <Qr value={l.data} size={132} label={l.text.trim()} />
                  <Text style={[s.paperLine, { fontSize: 10 }]} numberOfLines={2}>
                    {l.data}
                  </Text>
                </View>
              ) : (
                <Text key={i} style={[s.paperLine, l.style === 'bold' && { fontWeight: '800' }, l.style === 'double' && s.paperDouble]}>
                  {l.text || ' '}
                </Text>
              ),
            )}
          </ScrollView>
          <Pressable style={s.primary} onPress={() => setModal({ kind: 'none' })}>
            <Text style={s.primaryText}>{t('Done')}</Text>
          </Pressable>
        </Overlay>
      )}

      {modal.kind === 'device' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <DevicePanel
            rt={rt}
            status={sync}
            onCatalog={setCatalog}
            onForget={onForget}
            onError={(m) => setModal({ kind: 'error', message: m })}
          />
        </Overlay>
      )}

      {modal.kind === 'add_qty' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <NumberPad
            title={t('How many {name}?', { name: modal.item.name })}
            money={false}
            max={999}
            confirmLabel={(n) => t('Ring up {qty}', { qty: n || '' })}
            onCancel={() => setModal({ kind: 'none' })}
            onConfirm={(n) => {
              const { item, entry } = modal;
              setModal({ kind: 'none' });
              ring(item, { qty: n, entry });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'set_qty' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <NumberPad
            title={t('Quantity — {name}', { name: modal.name })}
            subtitle={t('0 removes the line')}
            money={false}
            max={9999}
            allowZero
            initial={modal.qty}
            confirmLabel={(n) => (n === 0 ? t('Remove line') : t('Set to {qty}', { qty: n }))}
            onCancel={() => setModal({ kind: 'none' })}
            onConfirm={(n) => {
              const lineId = modal.line_id;
              setModal({ kind: 'none' });
              void run(() => ses.setQty(lineId, n));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'open_price' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <NumberPad
            title={t('Price — {name}', { name: modal.item.name })}
            subtitle={t('Card price follows automatically (+{rate}%)', { rate: (catalog.dual_price_rate_ppm / 10_000).toString() })}
            money
            max={9_999_99}
            initial={modal.item.cash_price_cents || undefined}
            confirmLabel={(c) => (c ? t('Ring up {amount}', { amount: usd(c) }) : t('Enter a price'))}
            onCancel={() => setModal({ kind: 'none' })}
            onConfirm={(c) => {
              const { item, qty, entry, ageConfirmed } = modal;
              setModal({ kind: 'none' });
              const cash = cents(c);
              void run(() => ses.addItem(item, { qty, entry, ageConfirmed, price: { cash, card: deriveCardPrice(cash, catalog.dual_price_rate_ppm) } }));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'unknown' && (
        <Overlay>
          <UnknownItemForm
            code={modal.code}
            categories={catalog.categories.filter((c) => c.active !== false)}
            dualRatePpm={catalog.dual_price_rate_ppm}
            lookup={cardOk ? rt.upcLookup : undefined}
            onCancel={() => setModal({ kind: 'none' })}
            onCreate={(v) => void run(() => createUnknown(modal.code, v))}
            search={(q) => searchCatalog(shown, q, 8).map((h) => h.item)}
            onAttach={(item) => void run(() => attachUnknown(modal.code, item))}
          />
        </Overlay>
      )}

      {modal.kind === 'price_check' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <PriceCheckCard
            item={modal.item}
            showCost={modal.showCost}
            onDone={() => setModal({ kind: 'none' })}
            onShowCost={() => {
              const item = modal.item;
              const show = async () => setModal({ kind: 'price_check', item, showCost: true });
              // Margin only with a PIN that may see it (Bible 1.9).
              if (rt.staff.can('item.view_cost')) void run(show);
              else setModal({ kind: 'override', permission: 'item.view_cost', saleId: null, then: show });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'drawer' && (
        <Overlay>
          <DrawerPanel
            drawer={rt.drawer}
            staff={rt.staff}
            session={drawerSession}
            startWithFloat={modal.startWithFloat}
            startWithCounterfeit={!!modal.counterfeit}
            uploadPhoto={cardOk ? rt.uploadPhoto : null}
            onHandover={() => {
              const m = staff.member;
              void run(async () => {
                if (m) await rt.clock.clockOut(m.user_id, 'handover');
                await rt.staff.signOut('switch');
              });
            }}
            kick={async () => {
              await hardware.kickDrawer();
              rt.sync.kick();
            }}
            onStarted={modal.thenCash ? () => finishPendingCash() : undefined}
            onClose={() => setModal({ kind: 'none' })}
          />
        </Overlay>
      )}

      {modal.kind === 'held' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <HeldTickets
            session={ses}
            onClose={() => setModal({ kind: 'none' })}
            onRecall={(id) => {
              setModal({ kind: 'none' });
              void run(() => ses.recall(id));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'tickets' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <TicketBrowser
            store={rt.store}
            session={rt.session}
            staff={rt.staff}
            cardRefund={rt.payments.refund}
            onClose={() => setModal({ kind: 'none' })}
            onReprint={async (sale) => {
              await hardware.printReceipt(receiptFor(sale, 'reprint'));
              await ses.recordReceipt(sale.sale_id, 'reprint');
              rt.sync.kick();
            }}
            onCashBack={async (sale, amount, what) => {
              rt.log.info(what === 'void' ? 'completed sale voided' : 'refund', { sale: sale.sale_id.slice(0, 8), amount_cents: amount });
              // Only cash coming back opens the drawer; a card refund goes to the card.
              // Anything not paid by card (cash, a check, EBT…) comes back as cash (ADR 0050).
              if (amount > 0 && sale.tenders.some((t) => t.approved && t.tender_type !== 'card')) await hardware.kickDrawer();
              await hardware.printReceipt(receiptFor(sale, 'reprint', what === 'void' ? `VOID - ${usd(amount)} returned` : `REFUND - ${usd(amount)} returned`));
              await rt.drawer.refresh();
              rt.sync.kick();
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'override' && (
        <Overlay>
          <OverridePrompt
            gate={rt.staff}
            permission={modal.permission}
            saleId={modal.saleId}
            onCancel={() => setModal({ kind: 'none' })}
            onApproved={() => {
              const then = modal.then;
              setModal({ kind: 'none' });
              void run(then);
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'error' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{modal.done ? t('Done') : t('Can\'t do that')}</Text>
          <Text style={s.modalBody}>{modal.message}</Text>
          <Pressable style={s.primary} onPress={() => setModal({ kind: 'none' })}>
            <Text style={s.primaryText}>{t('OK')}</Text>
          </Pressable>
        </Overlay>
      )}
    </View>
  );
}

/** "Next customer" with a short countdown, so a zero-tap sale clears itself (P8). Any tap stops the timer. */
function AutoNext({ onNext, extra }: { onNext: () => void; extra: ReactNode }) {
  const t = useT();
  const [left, setLeft] = useState(4);
  const [held, setHeld] = useState(false);
  // The parent re-renders often (sync pill); keep the latest callback without restarting the countdown.
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (held) return;
    if (left <= 0) {
      next.current();
      return;
    }
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, held]);
  return (
    <View style={s.actions} onTouchStart={() => setHeld(true)}>
      {extra}
      <Pressable style={[s.primary, { backgroundColor: C.black }]} onPress={onNext}>
        <Text style={s.primaryText}>{held ? t('Next customer') : t('Next customer ({seconds})', { seconds: left })}</Text>
      </Pressable>
    </View>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.row}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.rowValue}>{usd(value)}</Text>
    </View>
  );
}

function SyncPill({ status, onPress }: { status: SyncStatus | null; onPress: () => void }) {
  const t = useT();
  const ok = status?.online && status.queued === 0;
  const label = !status
    ? t('Starting…')
    : status.online
      ? status.queued === 0
        ? t('Synced')
        : t('Syncing · {count} queued', { count: status.queued })
      : t('Offline · {count} queued', { count: status.queued });
  return (
    <Pressable onPress={onPress} style={[s.pill, ok ? s.pillOk : s.pillWarn]}>
      <Text style={[s.pillText, { color: ok ? C.green : C.amber }]}>{label}</Text>
    </Pressable>
  );
}

/** A key in the pad's slot next to the digits (@, PLU). */
function PadKey({ label, sub, onPress, disabled, accessibilityLabel }: { label: string; sub: string; onPress: () => void; disabled: boolean; accessibilityLabel: string }) {
  return (
    <Pressable style={[s.padKey, disabled && s.disabled]} disabled={disabled} onPress={onPress} accessibilityLabel={accessibilityLabel}>
      <Text style={s.padKeyText}>{label}</Text>
      <Text style={s.padKeySub}>{sub}</Text>
    </Pressable>
  );
}

/** The pad key that rings the typed amount to the department tab on screen (ADR 0046). */
function DepartmentKey({ dept, typed, onPress }: { dept: CatalogSnapshot['categories'][number] | null; typed: number; onPress: () => void }) {
  const t = useT();
  return (
    <Pressable
      style={[s.deptKey, !dept && s.disabled]}
      disabled={!dept}
      onPress={onPress}
      accessibilityLabel={dept ? t('Ring {amount} to {department}', { amount: usd(typed), department: dept.name }) : t('Pick a department tab to ring an amount to it')}
    >
      <Text style={s.deptKeyText} numberOfLines={2}>
        {dept ? t('→ {department}', { department: dept.name }) : t('Department')}
      </Text>
      <Text style={s.deptKeySub}>{!dept ? t('pick a tab') : typed > 0 ? usd(typed) : t('then the price')}</Text>
    </Pressable>
  );
}

function DevicePanel({
  rt,
  status,
  onCatalog,
  onForget,
  onError,
}: {
  rt: Runtime;
  status: SyncStatus | null;
  onCatalog: (c: CatalogSnapshot) => void;
  onForget: () => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const rows: [string, string][] = [
    [t('Register'), `${rt.identity.register_name} · ${rt.identity.register_id}`],
    [t('Location'), `${rt.identity.location_name} (${rt.identity.timezone})`],
    [t('Sync'), status ? (status.online ? t('online') : t('offline')) : '—'],
    [t('Queued events'), String(status?.queued ?? '—')],
    [t('Rejected events'), String(status?.rejected ?? 0)],
    [t('Last sync'), status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : t('never')],
    [t('Last error'), status?.lastError ?? '—'],
    [t('Catalog'), `v${status?.catalogVersion ?? rt.catalog.catalog_version}`],
    [t('Packs'), rt.identity.enabled_packs.join(', ')],
    [t('Realtime'), rt.ops.socketOpen() ? t('connected') : t('not connected (polling)')],
    ...Object.entries(PREVIEW_HEALTH).map(([slot, h]): [string, string] => [slot.replace('_', ' '), `${h.state}${h.detail ? ` · ${h.detail}` : ''}`]),
  ];
  const queued = status?.queued ?? 0;
  return (
    <>
      <Text style={s.modalTitle}>{t('Device')}</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={s.row}>
          <Text style={s.muted}>{k}</Text>
          <Text style={[s.rowValue, { fontWeight: '400', flexShrink: 1, textAlign: 'right' }]} selectable>
            {v}
          </Text>
        </View>
      ))}
      <View style={s.actions}>
        <Pressable style={s.ghost} onPress={() => rt.sync.kick()}>
          <Text>{t('Sync now')}</Text>
        </Pressable>
        <Pressable
          style={[s.ghost, busy && s.disabled]}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            const c = await rt.sync.pullCatalog();
            if (c) onCatalog(c);
            setBusy(false);
          }}
        >
          <Text>{t('Resync catalog')}</Text>
        </Pressable>
        <Pressable
          style={s.ghost}
          onPress={() =>
            queued > 0
              ? onError(t('{count} events have not reached the server yet. Sync before forgetting this pairing, or those sales would be stranded.', { count: queued }))
              : onForget()
          }
        >
          <Text>{t('Forget pairing')}</Text>
        </Pressable>
      </View>
    </>
  );
}

function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <View style={s.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={s.modal}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  mark: { backgroundColor: C.red, color: '#fff', fontWeight: '800' },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  disabled: { opacity: 0.4 },

  // Above the sale area, so the language menu that drops from it isn't hidden behind the ticket.
  topbar: { backgroundColor: C.black, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 52, gap: 16, zIndex: 30 },
  topBrand: { color: '#fff', fontSize: 18, fontWeight: '800' },
  topWhere: { color: '#ddd', flex: 1 },
  topLink: { color: '#ddd' },
  pill: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: 1, borderColor: '#444', paddingVertical: 4, paddingHorizontal: 12 },
  whoText: { color: '#fff', fontWeight: '700' },
  whoLock: { color: '#bbb', fontSize: 12 },
  pillOk: { backgroundColor: C.greenBg },
  pillWarn: { backgroundColor: C.amberBg },
  pillDark: { backgroundColor: '#333' },
  partPaid: { backgroundColor: C.ground, borderRadius: 8, padding: 8 },
  partPaidText: { color: C.ink, fontWeight: '600', fontSize: 13 },
  cashOnly: { backgroundColor: C.amberBg, borderRadius: 8, padding: 8 },
  cashOnlyText: { color: C.amber, fontWeight: '700', fontSize: 13 },
  pillText: { fontWeight: '700', fontSize: 12 },
  drawerFlash: { position: 'absolute', top: 60, alignSelf: 'center', backgroundColor: C.black, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16, zIndex: 5 },
  drawerText: { color: '#fff', fontWeight: '700' },
  ribbon: { color: '#ddd', fontSize: 13, maxWidth: 360 },
  ribbonUp: { color: '#6fd39b', fontWeight: '700' },
  onClock: { borderColor: '#2f7d4f' },
  dropBanner: { backgroundColor: '#fff4e5', borderColor: '#f3d7a8', borderWidth: 1, borderRadius: 8, padding: 10 },
  dropText: { color: C.ink, fontWeight: '700' },
  idWarn: { color: C.amber, fontWeight: '800', fontSize: 16 },
  trainingBanner: { backgroundColor: C.black, borderRadius: 8, padding: 10 },
  trainingText: { color: '#fff', fontWeight: '800' },
  zLine: { fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, fontSize: 12, color: C.ink },

  body: { flex: 1, flexDirection: 'row' },
  deptBar: { flexGrow: 0, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.line },
  deptRow: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  dept: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: C.line },
  padKey: { flex: 1, backgroundColor: C.ground, borderRadius: 8, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
  padKeyText: { color: C.ink, fontWeight: '800', fontSize: 18 },
  padKeySub: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  deptKey: { flex: 1, backgroundColor: C.black, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  deptKeyText: { color: '#fff', fontWeight: '800', textAlign: 'center' },
  deptKeySub: { color: '#ccc', fontSize: 12, fontVariant: ['tabular-nums'] },
  pageTab: { borderColor: C.black },
  tabGap: { width: 1, backgroundColor: C.line, marginHorizontal: 4 },
  returnBanner: { backgroundColor: C.black, borderRadius: 8, padding: 10, gap: 2 },
  returnText: { color: '#fff', fontWeight: '800' },
  returnSub: { color: '#ddd', fontSize: 12 },
  refundBtn: { backgroundColor: C.black, borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  refundText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  shortcutBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.line },
  catActive: { backgroundColor: C.black },
  catText: { fontWeight: '700', color: C.ink, fontSize: 15 },
  catAge: { color: C.muted, fontSize: 12, fontWeight: '600' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 10, alignContent: 'flex-start' },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 10, gap: 6 },
  search: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  clear: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  clearText: { fontSize: 20, color: C.muted, lineHeight: 22 },
  checkBanner: { marginHorizontal: 10, marginTop: 8, backgroundColor: C.black, borderRadius: 8, padding: 10, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  checkText: { color: '#fff', fontWeight: '700' },
  ghostOn: { backgroundColor: C.black, borderColor: C.black },

  ticket: { width: 340, borderLeftWidth: 1, borderLeftColor: C.line, backgroundColor: '#fff', padding: 14 },
  ticketTitle: { fontSize: 13, color: C.muted, fontWeight: '700', textTransform: 'uppercase', marginBottom: 8 },
  loyaltyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  loyaltyText: { color: C.ink, fontWeight: '600' },
  rewardButton: { backgroundColor: C.green, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  rewardButtonText: { color: '#fff', fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 8 },
  lineName: { color: C.ink, fontWeight: '600' },
  lineAmt: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'] },
  lineDeal: { color: C.green, fontSize: 12, fontWeight: '700' },
  sellSoon: { color: C.amber, fontWeight: '700', marginTop: 8 },
  remove: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.ground },
  removeText: { fontSize: 18, color: C.muted, lineHeight: 20 },
  totals: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  rowValue: { color: C.black, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dual: { flexDirection: 'row', gap: 8 },
  dualBox: { flex: 1, backgroundColor: C.ground, borderRadius: 8, padding: 10 },
  dualLabel: { fontSize: 12, color: C.muted, fontWeight: '700' },
  dualValue: { fontSize: 22, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  payBtn: { flex: 1, backgroundColor: C.black, borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  payText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  paySub: { color: '#bbb', fontSize: 11 },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  primary: { flexGrow: 1, backgroundColor: C.red, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { backgroundColor: '#fff', borderRadius: 14, padding: 20, width: '100%', maxWidth: 520, maxHeight: '92%', gap: 10 },
  modalTitle: { fontSize: 22, fontWeight: '800', color: C.ink },
  modalBody: { fontSize: 16, color: C.ink },
  changeLabel: { color: C.muted, fontWeight: '700' },
  changeValue: { fontSize: 56, fontWeight: '800', color: C.green, fontVariant: ['tabular-nums'] },

  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quick: { flexGrow: 1, minWidth: 90, backgroundColor: C.black, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  quickText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  keypadValue: { fontSize: 30, fontWeight: '800', color: C.black, textAlign: 'right', fontVariant: ['tabular-nums'] },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keyBtn: { width: '31%', flexGrow: 1, backgroundColor: C.ground, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  keyBtnText: { fontSize: 20, fontWeight: '700', color: C.ink },

  paper: { backgroundColor: '#fffef8', borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 12, maxHeight: 420 },
  paperLine: { fontFamily: Platform.select({ web: 'ui-monospace, Consolas, monospace', default: 'monospace' }), fontSize: 12, color: '#222' },
  paperDouble: { fontSize: 14, fontWeight: '800' },
  paperLogo: { width: '100%', height: 64, marginBottom: 4 },
  paperQr: { alignItems: 'center', borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 6, marginVertical: 4 },
});

/** Name a usual: "Mike — coffee + Newports". Saved online; every register gets it with the next sync. */
function SaveUsual({ suggestion, onSave, onCancel }: { suggestion: string; onSave: (label: string) => void; onCancel: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(suggestion.slice(0, 40));
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.modalTitle}>{t('Save this ticket as a usual')}</Text>
      <Text style={s.modalBody}>{t('One tap rings it again. It’s yours: it shows when you’re signed in.')}</Text>
      <TextInput style={s.search} value={label} onChangeText={setLabel} maxLength={40} autoFocus placeholder={t('Mike — coffee + Newports')} />
      <View style={s.actions}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>{t('Cancel')}</Text>
        </Pressable>
        <Pressable style={[s.primary, !label.trim() && s.disabled]} disabled={!label.trim()} onPress={() => onSave(label.trim())}>
          <Text style={s.primaryText}>{t('Save usual')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
