/**
 * Merchant-facing 15.6" sale screen: quick keys → ticket → cash tender → drawer → receipt.
 * Every button calls the SaleSession, which appends events; the ticket shown is the fold of those
 * events. Works fully offline; the sync pill shows what's queued.
 */
import {
  WedgeDecoder,
  barcodeIndex,
  cardAmountFor,
  categoryKeys,
  cents,
  deriveCardPrice,
  favoriteKeys,
  foldSale,
  bagFeesOn,
  effectiveMinAge,
  feeItem,
  lineTotal,
  resolveFlags,
  localDate,
  lookupBarcode,
  searchCatalog,
  quickCashOptions,
  renderReceipt,
  type CatalogItem,
  type CatalogSnapshot,
  type Cents,
  type FoldedSale,
  type Permission,
  type ReceiptLine,
} from '@adpay/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DevSettings, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createDisplayChannel, displayFor } from '../core/display';
import { PREVIEW_HEALTH, WebPreviewHardware, type Hardware } from '../core/hardware';
import type { SessionState } from '../core/session';
import { pendingItem } from '../core/new-items';
import type { StaffState } from '../core/staff';
import type { SyncStatus } from '../core/sync';
import { API_URL, type Runtime } from '../runtime';
import { QuickKey } from './QuickKey';
import { DrawerPanel } from './DrawerUI';
import { CardPanel, type CardPhase } from './TenderUI';
import { HeldTickets, TicketBrowser } from './TicketsUI';
import { NumberPad, PriceCheckCard, UnknownItemForm } from './SpeedUI';
import { OverridePrompt, SignInScreen } from './StaffUI';
import { C, usd } from './theme';

const FAVORITES = '__favorites__';

type Entry = 'key' | 'scan' | 'search' | 'new_item';

type Modal =
  | { kind: 'none' }
  | { kind: 'age'; item: CatalogItem; qty: number; entry: Entry }
  | { kind: 'add_qty'; item: CatalogItem; entry: Entry }
  | { kind: 'set_qty'; line_id: string; name: string; qty: number }
  | { kind: 'open_price'; item: CatalogItem; qty: number; entry: Entry; ageConfirmed: boolean }
  | { kind: 'unknown'; code: string }
  | { kind: 'price_check'; item: CatalogItem; showCost: boolean }
  | { kind: 'drawer'; startWithFloat: boolean; thenCash: boolean }
  | { kind: 'held' }
  | { kind: 'tickets' }
  | { kind: 'card'; phase: CardPhase }
  | { kind: 'cash' }
  | { kind: 'done'; sale: FoldedSale; change: number; after: 'ask' | 'print' | 'none'; printed: readonly ReceiptLine[] | null }
  | { kind: 'receipt'; lines: readonly ReceiptLine[]; title: string }
  | { kind: 'device' }
  | { kind: 'override'; permission: Permission; saleId: string | null; then: () => Promise<unknown> }
  | { kind: 'error'; message: string };

export function SaleScreen({ rt, onForget }: { rt: Runtime; onForget: () => void }) {
  const [catalog, setCatalog] = useState<CatalogSnapshot>(rt.catalog);
  const [session, setSession] = useState<SessionState>(rt.session.state());
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // FAVORITES is the location's own first page; a store without favorites opens on its first category.
  const [category, setCategory] = useState<string | null>(favoriteKeys(rt.catalog).length ? FAVORITES : (rt.catalog.categories[0]?.category_id ?? null));
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [drawerFlash, setDrawerFlash] = useState(false);
  const display = useRef(createDisplayChannel()).current;

  /** True while printing a receipt automatically (after_sale: print): don't pop the preview over the change. */
  const quietPrint = useRef(false);
  const hardware: Hardware = useMemo(
    () =>
      new WebPreviewHardware(
        (lines) => {
          if (quietPrint.current) return;
          setModal({ kind: 'receipt', lines, title: 'Receipt (printer preview)' });
        },
        () => {
          setDrawerFlash(true);
          setTimeout(() => setDrawerFlash(false), 1500);
        },
      ),
    [],
  );

  const [drawerSession, setDrawerSession] = useState(rt.drawer.current());
  useEffect(() => rt.drawer.subscribe(setDrawerSession), [rt]);
  const [staff, setStaff] = useState<StaffState>(rt.staff.state());
  useEffect(() => rt.staff.subscribe(setStaff), [rt]);
  useEffect(() => rt.session.subscribe(setSession), [rt]);
  useEffect(() => rt.sync.subscribe(setSync), [rt]);
  // A newer catalog (price change, new item, reordered category) replaces the keys in place.
  useEffect(() => rt.sync.onCatalog(setCatalog), [rt]);

  // Customer screen follows the ticket (unless it's showing "thank you").
  useEffect(() => {
    if (modal.kind !== 'done') display.publish(displayFor(rt.identity.merchant_name, session.sale));
  }, [session.sale, modal.kind, display, rt.identity.merchant_name]);

  const sale = session.sale;
  // Feature flags for this merchant (P12b); an older snapshot without them means everything on.
  const flags = resolveFlags(catalog.flags ?? {});
  const cardOk = sync?.online ?? false;
  // Items created here but not yet in a server snapshot are overlaid, so they ring up offline (P5).
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => rt.items.subscribe((p) => setPendingCount(p.length)), [rt]);
  // pendingCount is the change signal: the outbox mutates in place, so the memo keys on its size.
  const shown = useMemo(() => rt.items.overlay(catalog), [rt, catalog, pendingCount]);
  const index = useMemo(() => barcodeIndex(shown), [shown]);
  const [query, setQuery] = useState('');
  const [priceCheck, setPriceCheck] = useState(false);
  const favorites = useMemo(() => favoriteKeys(shown), [shown]);
  const results = useMemo(() => (query.trim() ? searchCatalog(shown, query, 40).map((h) => h.item) : null), [shown, query]);
  const items = useMemo(
    () => results ?? (category === FAVORITES ? favorites : categoryKeys(shown, category)),
    [results, shown, category, favorites],
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
  const ring = (item: CatalogItem, opts: { qty?: number; entry: Entry; ageConfirmed?: boolean }) => {
    const qty = opts.qty ?? 1;
    if (priceCheck) return setModal({ kind: 'price_check', item, showCost: false });
    if (item.min_age && !opts.ageConfirmed && !rt.session.wouldMerge(item)) return setModal({ kind: 'age', item, qty, entry: opts.entry });
    if (item.open_price) return setModal({ kind: 'open_price', item, qty, entry: opts.entry, ageConfirmed: !!opts.ageConfirmed });
    void run(() => rt.session.addItem(item, { qty, entry: opts.entry, ageConfirmed: !!opts.ageConfirmed }));
  };
  const addItem = (item: CatalogItem) => ring(item, { entry: query ? 'search' : 'key' });
  // Compliance (P10): bag-fee keys in force today, and each category's effective age check.
  const today = localDate(new Date(), rt.identity.timezone);
  const bagFees = bagFeesOn(catalog.compliance?.charges ?? [], today);
  const catAge = (c: CatalogSnapshot['categories'][number]) => effectiveMinAge(c.min_age, c.restriction ?? null, catalog.compliance?.min_ages ?? null);

  /** A scanned (or typed) barcode: ring it, or offer to add it to the catalog if we don't know it. */
  const onCode = (code: string) => {
    const hit = lookupBarcode(index, code);
    if (hit) {
      rt.log.info('scan', { matched: hit.matched, qty: hit.qty });
      ring(hit.item, { qty: hit.qty, entry: 'scan' });
    } else if (priceCheck || !flags.register_item_create) {
      setModal({ kind: 'error', message: `Barcode ${code} isn’t in the catalog.${priceCheck ? '' : ' Ask the owner to add it.'}` });
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
  useEffect(() => {
    if (Platform.OS !== 'web') return; // The Kotlin module delivers scans on the device (P-HW).
    const decoder = new WedgeDecoder();
    const onKey = (e: KeyboardEvent) => {
      const code = decoder.feed(e.key, e.timeStamp || performance.now());
      if (!code) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
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
      created_by_user_id: rt.session.actorId(),
      created_at: new Date().toISOString(),
    };
    await rt.items.add(cmd);
    rt.log.info('item created at the register', { name: v.name, code });
    setModal({ kind: 'none' });
    ring(pendingItem(catalog, cmd), { entry: 'new_item' });
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
      ...(footer ? { footer } : {}),
      ...(receiptSettings
        ? { settings: receiptSettings, logo_url: receiptSettings.logo_url ? `${API_URL}${receiptSettings.logo_url}` : null }
        : {}),
    });

  // Remote actions that need this screen or the printer (P4): reprint any sale rung here, test page, restart.
  useEffect(() => {
    rt.ops.setHandlers({
      reprint: async (saleId) => {
        const events = await rt.store.eventsForSale(saleId);
        if (events.length === 0) throw new Error('That sale is not on this register');
        await hardware.printReceipt(receiptFor(foldSale(saleId, events), 'reprint'));
        await rt.session.recordReceipt(saleId, 'reprint');
        return `Reprinted ticket ${saleId.slice(0, 4).toUpperCase()}`;
      },
      printerTest: async () => {
        await hardware.printReceipt([
          { text: 'AD PAY — PRINTER TEST', style: 'double' },
          { text: `${rt.identity.merchant_name} · ${rt.identity.register_name}`, style: 'normal' },
          { text: new Date().toLocaleString(), style: 'normal' },
          { text: 'If you can read this, the printer works.', style: 'normal' },
        ]);
        return 'Test page printed';
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
    await hardware.kickDrawer();
    await rt.session.recordDrawer('cash_sale', saleId);
    await rt.drawer.refresh();
  }

  async function tender(amount: number, partial = false) {
    await run(async () => {
      const saleId = sale!.sale_id;
      const r = await rt.session.tenderCash(cents(amount), { partial });
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
      const t = retry ?? (await rt.session.startCard(amount));
      setModal({ kind: 'card', phase: { kind: 'waiting', amount: t.amount } });
      display.publish(displayFor(rt.identity.merchant_name, current, undefined, { phase: 'card', amount: t.amount }));
      const r = await rt.payments.charge(current.sale_id, t.tender_id, t.amount);
      const res = await rt.session.finishCard(t.tender_id, t.amount, { ...r, status: r.status });
      rt.log.info('card', { status: r.status, sale: current.sale_id.slice(0, 8), amount_cents: t.amount });
      if (r.status === 'approved') {
        display.publish(displayFor(rt.identity.merchant_name, res.sale, undefined, { phase: 'approved', amount: t.amount }));
        if (res.completed) await completed(res.sale, res.sale.paid_cents, 0);
        else setModal({ kind: 'card', phase: { kind: 'ready' } }); // two cards: the rest
      } else if (r.status === 'declined') {
        display.publish(displayFor(rt.identity.merchant_name, res.sale, undefined, { phase: 'declined', amount: t.amount }));
        setModal({ kind: 'card', phase: { kind: 'declined', message: r.message } });
      } else {
        // The customer sees their cart again, never "system down"; the cashier sees what happened.
        display.publish(displayFor(rt.identity.merchant_name, res.sale));
        setModal({ kind: 'card', phase: { kind: 'error', message: r.message, retry: t } });
      }
      rt.sync.kick();
    });
  }

  /** Every paid sale ends here: customer screen, after-sale receipt choice, the done screen. */
  async function completed(done: FoldedSale, amount: number, change: number) {
    display.publish(displayFor(rt.identity.merchant_name, done, { amount, change }));
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
      await rt.session.recordReceipt(done.sale_id, 'original');
    } else if (after === 'none') {
      await rt.session.recordReceipt(done.sale_id, 'none');
    }
    setModal({ kind: 'done', sale: done, change, after, printed });
    rt.sync.kick();
  }

  async function finishReceipt(done: FoldedSale, print: boolean) {
    await run(async () => {
      if (print) await hardware.printReceipt(receiptFor(done, 'original'));
      else setModal({ kind: 'none' });
      await rt.session.recordReceipt(done.sale_id, print ? 'original' : 'none');
      display.publish(displayFor(rt.identity.merchant_name, null));
      rt.sync.kick();
    });
  }

  async function reprintLast() {
    await run(async () => {
      const events = await rt.session.lastSaleEvents();
      const last = session.lastCompleted;
      if (!last || events.length === 0) throw new Error('No completed sale on this register yet');
      await hardware.printReceipt(receiptFor(foldSale(last.sale_id, events), 'reprint'));
      await rt.session.recordReceipt(last.sale_id, 'reprint');
      rt.sync.kick();
    });
  }

  function openCustomerScreen() {
    if (Platform.OS === 'web') window.open('/?display=customer', 'adpay-customer', 'width=1024,height=640');
  }

  // Nobody signed in (and this store uses PINs): the counter shows "who's working?" and nothing else.
  if (staff.required && !staff.member) return <SignInScreen gate={rt.staff} storeName={`${rt.identity.merchant_name} · ${rt.identity.location_name}`} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={s.topbar}>
        <Text style={s.topBrand}>
          <Text style={s.mark}> AD </Text> Pay
        </Text>
        <Text style={s.topWhere} numberOfLines={1}>
          {rt.identity.merchant_name} · {rt.identity.location_name} · {rt.identity.register_name}
        </Text>
        {staff.member ? (
          <Pressable onPress={() => void run(() => rt.staff.signOut('manual'))} style={s.who} accessibilityLabel={`Signed in as ${staff.member.name}. Tap to lock.`}>
            <Text style={s.whoText}>{staff.member.name.split(' ')[0]}</Text>
            <Text style={s.whoLock}>Lock</Text>
          </Pressable>
        ) : (
          <View style={[s.pill, s.pillWarn]}>
            <Text style={[s.pillText, { color: C.amber }]}>No staff PINs set up</Text>
          </View>
        )}
        <Pressable onPress={() => setModal({ kind: 'drawer', startWithFloat: false, thenCash: false })} style={[s.pill, drawerSession ? s.pillDark : s.pillWarn]}>
          <Text style={[s.pillText, { color: drawerSession ? '#fff' : C.amber }]}>{drawerSession ? 'Drawer' : 'Drawer not started'}</Text>
        </Pressable>
        <SyncPill status={sync} onPress={() => setModal({ kind: 'device' })} />
        {Platform.OS === 'web' ? (
          <Pressable onPress={openCustomerScreen}>
            <Text style={s.topLink}>Customer screen ↗</Text>
          </Pressable>
        ) : null}
      </View>
      {drawerFlash ? (
        <View style={s.drawerFlash}>
          <Text style={s.drawerText}>Drawer opened</Text>
        </View>
      ) : null}

      <View style={s.body}>
        <View style={s.catCol}>
          {favorites.length > 0 ? (
            <Pressable onPress={() => setCategory(FAVORITES)} style={[s.cat, category === FAVORITES && s.catActive]}>
              <Text style={[s.catText, category === FAVORITES && { color: '#fff' }]}>★ Favorites</Text>
            </Pressable>
          ) : null}
          {catalog.categories.filter((c) => c.active !== false).map((c) => (
            <Pressable key={c.category_id} onPress={() => setCategory(c.category_id)} style={[s.cat, category === c.category_id && s.catActive]}>
              <Text style={[s.catText, category === c.category_id && { color: '#fff' }]}>{c.name}</Text>
              {catAge(c) ? <Text style={[s.catAge, category === c.category_id && { color: '#ddd' }]}>{catAge(c)}+</Text> : null}
            </Pressable>
          ))}
        </View>

        <View style={{ flex: 1 }}>
          <View style={s.searchRow}>
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search name, UPC or PLU — or scan"
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
              accessibilityLabel="Search items"
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} style={s.clear} accessibilityLabel="Clear search">
                <Text style={s.clearText}>×</Text>
              </Pressable>
            ) : null}
          </View>
          {priceCheck ? (
            <View style={s.checkBanner}>
              <Text style={s.checkText}>Price check — scan or tap an item to see its prices. Nothing is rung up.</Text>
              <Pressable onPress={() => setPriceCheck(false)}>
                <Text style={s.checkText}>Done</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.grid} keyboardShouldPersistTaps="handled">
            {items.map((i) => (
              <QuickKey key={i.item_id} item={i} onPress={addItem} onLongPress={(it) => setModal({ kind: 'add_qty', item: it, entry: query ? 'search' : 'key' })} />
            ))}
            {results && results.length === 0 ? (
              <Text style={s.mutedSmall}>
                Nothing matches “{query}”.{/^\d{6,}$/.test(query.trim()) ? ' Press Enter to add it as a new item.' : ''}
              </Text>
            ) : null}
          </ScrollView>
        </View>

        <View style={s.ticket}>
          <Text style={s.ticketTitle}>{sale ? `Ticket ${sale.sale_id.slice(0, 4).toUpperCase()}` : 'New ticket'}</Text>
          <ScrollView style={{ flex: 1 }}>
            {!sale || sale.lines.length === 0 ? (
              <Text style={s.mutedSmall}>Tap an item to start a sale.</Text>
            ) : (
              sale.lines.map((l) => (
                <Pressable
                  key={l.line_id}
                  style={s.line}
                  onLongPress={() => setModal({ kind: 'set_qty', line_id: l.line_id, name: l.name, qty: l.qty })}
                  delayLongPress={450}
                  accessibilityHint="Long-press to change the quantity"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.lineName}>
                      {l.qty > 1 ? `${l.qty} × ` : ''}
                      {l.name}
                    </Text>
                    <Text style={s.mutedSmall}>
                      card {usd(lineTotal(l, 'card'))}
                      {l.charges.map((c) => ` · incl. ${c.label}`).join('')}
                      {l.min_age ? ` · ${l.min_age}+ checked` : ''}
                      {!l.taxable ? ' · no tax' : ''}
                    </Text>
                  </View>
                  <Text style={s.lineAmt}>{usd(lineTotal(l, 'cash'))}</Text>
                  <Pressable onPress={() => void run(() => rt.session.removeLine(l.line_id))} style={s.remove} accessibilityLabel={`Remove ${l.name}`}>
                    <Text style={s.removeText}>×</Text>
                  </Pressable>
                </Pressable>
              ))
            )}
          </ScrollView>
          <View style={s.totals}>
            <Row label="Subtotal" value={sale?.cash.subtotal_cents ?? 0} />
            <Row label="Tax" value={sale?.cash.tax_cents ?? 0} />
            <View style={s.dual}>
              <View style={s.dualBox}>
                <Text style={s.dualLabel}>Cash</Text>
                <Text style={s.dualValue}>{usd(sale?.cash.total_cents ?? 0)}</Text>
              </View>
              <View style={s.dualBox}>
                <Text style={s.dualLabel}>Card</Text>
                <Text style={s.dualValue}>{usd(sale?.card.total_cents ?? 0)}</Text>
              </View>
            </View>
            {sale && sale.tenders.some((t) => t.approved) ? (
              <View style={s.partPaid}>
                <Text style={s.partPaidText}>
                  Paid so far {usd(sale.paid_cents)} · left {usd(sale.remaining_cash_cents)} cash or{' '}
                  {usd(cardAmountFor(sale.remaining_cash_cents, sale.cash.total_cents, sale.card.total_cents))} card
                </Text>
              </View>
            ) : null}
            {flags.card_payments && !cardOk && sale?.lines.length ? (
              // Bible 1.7: when the card path is down, say so plainly and keep selling for cash.
              <Pressable style={s.cashOnly} onPress={() => rt.sync.kick()}>
                <Text style={s.cashOnlyText}>Cash only right now — no connection to the card machine. Tap to retry.</Text>
              </Pressable>
            ) : null}
            <View style={s.actions}>
              <Pressable
                style={[s.payBtn, !sale?.lines.length && s.disabled]}
                disabled={!sale?.lines.length}
                // Cash needs a started drawer (a counted float), so the day reconciles to the cent.
                onPress={() => setModal(rt.drawer.current() ? { kind: 'cash' } : { kind: 'drawer', startWithFloat: true, thenCash: true })}
              >
                <Text style={s.payText}>Cash</Text>
              </Pressable>
              {flags.card_payments ? (
              <Pressable
                style={[s.payBtn, (!sale?.lines.length || !cardOk) && s.disabled]}
                disabled={!sale?.lines.length || !cardOk}
                onPress={() => setModal({ kind: 'card', phase: { kind: 'ready' } })}
              >
                <Text style={s.payText}>Card</Text>
                {!cardOk ? <Text style={s.paySub}>offline</Text> : null}
              </Pressable>
              ) : null}
            </View>
            {bagFees.length ? (
              // Bag fees in force today (P10): one tap adds a bag; tap again for another.
              <View style={s.actions}>
                {bagFees.map((r) => (
                  <Pressable
                    key={r.rule_id}
                    style={s.ghost}
                    onPress={() => void run(() => rt.session.addItem(feeItem(r, catalog.tax_rate_ppm), { entry: 'key', fee: true }))}
                    accessibilityLabel={`Add ${r.label}`}
                  >
                    <Text>+ {r.label} {usd(cents(r.amount_cents ?? 0))}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={s.actions}>
              <Pressable
                style={[s.ghost, !sale && s.disabled]}
                disabled={!sale}
                onPress={() => sale && guarded('ticket.void', sale.sale_id, () => rt.session.voidSale('Voided at register'))}
              >
                <Text>Void ticket</Text>
              </Pressable>
              <Pressable style={[s.ghost, !session.lastCompleted && s.disabled]} disabled={!session.lastCompleted} onPress={() => void reprintLast()}>
                <Text>Reprint last</Text>
              </Pressable>
              {flags.hold_tickets ? (
                <Pressable style={[s.ghost, !sale?.lines.length && s.disabled]} disabled={!sale?.lines.length} onPress={() => void run(() => rt.session.hold())}>
                  <Text>Hold</Text>
                </Pressable>
              ) : null}
              {session.parked.length ? (
                <Pressable style={[s.ghost, s.ghostOn]} onPress={() => setModal({ kind: 'held' })}>
                  <Text style={{ color: '#fff' }}>Held ({session.parked.length})</Text>
                </Pressable>
              ) : null}
              <Pressable style={s.ghost} onPress={() => setModal({ kind: 'tickets' })}>
                <Text>Tickets</Text>
              </Pressable>
              {flags.price_check ? (
                <Pressable style={[s.ghost, priceCheck && s.ghostOn]} onPress={() => setPriceCheck((v) => !v)}>
                  <Text style={priceCheck ? { color: '#fff' } : undefined}>Price check</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </View>

      {modal.kind === 'age' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>Check ID — {modal.item.min_age}+</Text>
          <Text style={s.modalBody}>
            {modal.item.name} is age-restricted. Confirm the customer is {modal.item.min_age} or older.
          </Text>
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => setModal({ kind: 'none' })}>
              <Text>Not verified</Text>
            </Pressable>
            <Pressable
              style={s.primary}
              onPress={() => {
                const { item, qty, entry } = modal;
                setModal({ kind: 'none' });
                ring(item, { qty, entry, ageConfirmed: true });
              }}
            >
              <Text style={s.primaryText}>ID checked — {modal.item.min_age}+</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'cash' && sale && (
        <CashModal
          total={sale.remaining_cash_cents}
          allowPart={cardOk && flags.card_payments}
          onCancel={() => setModal({ kind: 'none' })}
          onTender={(amt) => void tender(amt)}
          onPart={(amt) => void tender(amt, true)}
        />
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
              display.publish(displayFor(rt.identity.merchant_name, sale));
              setModal(rt.drawer.current() ? { kind: 'cash' } : { kind: 'drawer', startWithFloat: true, thenCash: true });
            }}
            onBack={() => {
              display.publish(displayFor(rt.identity.merchant_name, sale));
              setModal({ kind: 'none' });
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'done' && (
        <Overlay>
          <Text style={s.modalTitle}>Sale complete</Text>
          {/* Change only when cash was handed over; an all-card sale has none to give. */}
          {modal.sale.price_mode !== 'card' ? (
            <>
              <Text style={s.changeLabel}>Change due</Text>
              <Text style={s.changeValue}>{usd(modal.change)}</Text>
            </>
          ) : null}
          <Text style={s.modalBody}>
            {modal.sale.price_mode === 'card'
              ? `Paid ${usd(modal.sale.paid_cents)} by card${modal.sale.tenders.find((t) => t.card)?.card?.last4 ? ` ···· ${modal.sale.tenders.find((t) => t.card)!.card!.last4}` : ''}`
              : modal.sale.price_mode === 'split'
                ? `Paid ${usd(modal.sale.paid_cents)}: ${modal.sale.tenders
                    .filter((t) => t.approved)
                    .map((t) => `${usd(t.amount_cents)} ${t.tender_type}`)
                    .join(' + ')}`
                : `Total ${usd(modal.sale.cash.total_cents)} cash · drawer opened`}
            {modal.after === 'print' ? ' · receipt printed' : ''}
          </Text>
          {modal.after === 'ask' ? (
            <View style={s.actions}>
              <Pressable style={s.ghost} onPress={() => void finishReceipt(modal.sale, false)}>
                <Text>No receipt</Text>
              </Pressable>
              <Pressable style={s.primary} onPress={() => void finishReceipt(modal.sale, true)}>
                <Text style={s.primaryText}>Print receipt</Text>
              </Pressable>
            </View>
          ) : (
            <AutoNext
              key={modal.sale.sale_id}
              onNext={() => {
                setModal({ kind: 'none' });
                display.publish(displayFor(rt.identity.merchant_name, null));
              }}
              extra={
                modal.after === 'none' ? (
                  <Pressable
                    style={s.ghost}
                    onPress={() =>
                      void run(async () => {
                        await hardware.printReceipt(receiptFor(modal.sale, 'reprint'));
                        await rt.session.recordReceipt(modal.sale.sale_id, 'reprint');
                        display.publish(displayFor(rt.identity.merchant_name, null));
                      })
                    }
                  >
                    <Text>Print receipt</Text>
                  </Pressable>
                ) : modal.printed ? (
                  <Pressable style={s.ghost} onPress={() => setModal({ kind: 'receipt', lines: modal.printed!, title: 'Receipt (printer preview)' })}>
                    <Text>See receipt</Text>
                  </Pressable>
                ) : null
              }
            />
          )}
        </Overlay>
      )}

      {modal.kind === 'receipt' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{modal.title}</Text>
          <ScrollView style={s.paper}>
            {modal.lines.map((l, i) =>
              l.style === 'logo' ? (
                <Image key={i} source={{ uri: l.url }} style={s.paperLogo} resizeMode="contain" accessibilityLabel="Store logo" />
              ) : l.style === 'qr' ? (
                // The printer module prints a real QR (ESC/POS native); the preview shows where and what.
                <View key={i} style={s.paperQr}>
                  <Text style={s.paperQrText}>▣ QR</Text>
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
            <Text style={s.primaryText}>Done</Text>
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
            title={`How many ${modal.item.name}?`}
            money={false}
            max={999}
            confirmLabel={(n) => `Ring up ${n || ''}`}
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
            title={`Quantity — ${modal.name}`}
            subtitle="0 removes the line"
            money={false}
            max={9999}
            allowZero
            initial={modal.qty}
            confirmLabel={(n) => (n === 0 ? 'Remove line' : `Set to ${n}`)}
            onCancel={() => setModal({ kind: 'none' })}
            onConfirm={(n) => {
              const lineId = modal.line_id;
              setModal({ kind: 'none' });
              void run(() => rt.session.setQty(lineId, n));
            }}
          />
        </Overlay>
      )}

      {modal.kind === 'open_price' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <NumberPad
            title={`Price — ${modal.item.name}`}
            subtitle={`Card price follows automatically (+${(catalog.dual_price_rate_ppm / 10_000).toString()}%)`}
            money
            max={9_999_99}
            initial={modal.item.cash_price_cents || undefined}
            confirmLabel={(c) => (c ? `Ring up ${usd(c)}` : 'Enter a price')}
            onCancel={() => setModal({ kind: 'none' })}
            onConfirm={(c) => {
              const { item, qty, entry, ageConfirmed } = modal;
              setModal({ kind: 'none' });
              const cash = cents(c);
              void run(() => rt.session.addItem(item, { qty, entry, ageConfirmed, price: { cash, card: deriveCardPrice(cash, catalog.dual_price_rate_ppm) } }));
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
            onCancel={() => setModal({ kind: 'none' })}
            onCreate={(v) => void run(() => createUnknown(modal.code, v))}
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
            kick={async () => {
              await hardware.kickDrawer();
              rt.sync.kick();
            }}
            onStarted={modal.thenCash ? () => setModal({ kind: 'cash' }) : undefined}
            onClose={() => setModal({ kind: 'none' })}
          />
        </Overlay>
      )}

      {modal.kind === 'held' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <HeldTickets
            session={rt.session}
            onClose={() => setModal({ kind: 'none' })}
            onRecall={(id) => {
              setModal({ kind: 'none' });
              void run(() => rt.session.recall(id));
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
              await rt.session.recordReceipt(sale.sale_id, 'reprint');
              rt.sync.kick();
            }}
            onCashBack={async (sale, amount, what) => {
              rt.log.info(what === 'void' ? 'completed sale voided' : 'refund', { sale: sale.sale_id.slice(0, 8), amount_cents: amount });
              // Only cash coming back opens the drawer; a card refund goes to the card.
              if (amount > 0 && sale.tenders.some((t) => t.tender_type === 'cash')) await hardware.kickDrawer();
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
          <Text style={s.modalTitle}>Can't do that</Text>
          <Text style={s.modalBody}>{modal.message}</Text>
          <Pressable style={s.primary} onPress={() => setModal({ kind: 'none' })}>
            <Text style={s.primaryText}>OK</Text>
          </Pressable>
        </Overlay>
      )}
    </View>
  );
}

/** "Next customer" with a short countdown, so a zero-tap sale clears itself (P8). Any tap stops the timer. */
function AutoNext({ onNext, extra }: { onNext: () => void; extra: ReactNode }) {
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
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, held]);
  return (
    <View style={s.actions} onTouchStart={() => setHeld(true)}>
      {extra}
      <Pressable style={[s.primary, { backgroundColor: C.black }]} onPress={onNext}>
        <Text style={s.primaryText}>Next customer{held ? '' : ` (${left})`}</Text>
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
  const ok = status?.online && status.queued === 0;
  const label = !status
    ? 'Starting…'
    : status.online
      ? status.queued === 0
        ? 'Synced'
        : `Syncing · ${status.queued} queued`
      : `Offline · ${status.queued} queued`;
  return (
    <Pressable onPress={onPress} style={[s.pill, ok ? s.pillOk : s.pillWarn]}>
      <Text style={[s.pillText, { color: ok ? C.green : C.amber }]}>{label}</Text>
    </Pressable>
  );
}

function CashModal({
  total,
  allowPart,
  onCancel,
  onTender,
  onPart,
}: {
  total: number;
  allowPart: boolean;
  onCancel: () => void;
  onTender: (amount: number) => void;
  /** Split: take this much cash now, the rest on a card. */
  onPart: (amount: number) => void;
}) {
  const [digits, setDigits] = useState('');
  const typed = digits ? Number(digits) : 0; // keypad fills from the cents column: 2-0-0-0 → $20.00
  const options = quickCashOptions(cents(total));
  const press = (k: string) => setDigits((d) => (k === '⌫' ? d.slice(0, -1) : (d + k).replace(/^0+/, '').slice(0, 7)));
  return (
    <Overlay onClose={onCancel}>
      <Text style={s.modalTitle}>Cash — {usd(total)}</Text>
      <View style={s.quickRow}>
        {options.map((o) => (
          <Pressable key={o} style={s.quick} onPress={() => onTender(o)}>
            <Text style={s.quickText}>{o === total ? 'Exact' : usd(o)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.muted}>Other amount</Text>
      <Text style={s.keypadValue}>{usd(typed)}</Text>
      <View style={s.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map((k) => (
          <Pressable key={k} style={s.keyBtn} onPress={() => press(k)}>
            <Text style={s.keyBtnText}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.actions}>
        <Pressable style={s.ghost} onPress={onCancel}>
          <Text>Back</Text>
        </Pressable>
        {/* Black, not red: these buttons carry dollar amounts. */}
        {typed > 0 && typed < total && allowPart ? (
          <Pressable style={[s.primary, { backgroundColor: C.black }]} onPress={() => onPart(typed)}>
            <Text style={s.primaryText}>Take {usd(typed)} now, rest by card</Text>
          </Pressable>
        ) : (
          <Pressable style={[s.primary, { backgroundColor: C.black }, typed < total && s.disabled]} disabled={typed < total} onPress={() => onTender(typed)}>
            <Text style={s.primaryText}>Take {usd(typed)}</Text>
          </Pressable>
        )}
      </View>
    </Overlay>
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
  const [busy, setBusy] = useState(false);
  const rows: [string, string][] = [
    ['Register', `${rt.identity.register_name} · ${rt.identity.register_id}`],
    ['Location', `${rt.identity.location_name} (${rt.identity.timezone})`],
    ['Sync', status ? (status.online ? 'online' : 'offline') : '—'],
    ['Queued events', String(status?.queued ?? '—')],
    ['Rejected events', String(status?.rejected ?? 0)],
    ['Last sync', status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : 'never'],
    ['Last error', status?.lastError ?? '—'],
    ['Catalog', `v${status?.catalogVersion ?? rt.catalog.catalog_version}`],
    ['Packs', rt.identity.enabled_packs.join(', ')],
    ['Realtime', rt.ops.socketOpen() ? 'connected' : 'not connected (polling)'],
    ...Object.entries(PREVIEW_HEALTH).map(([slot, h]): [string, string] => [slot.replace('_', ' '), `${h.state}${h.detail ? ` · ${h.detail}` : ''}`]),
  ];
  const queued = status?.queued ?? 0;
  return (
    <>
      <Text style={s.modalTitle}>Device</Text>
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
          <Text>Sync now</Text>
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
          <Text>Resync catalog</Text>
        </Pressable>
        <Pressable
          style={s.ghost}
          onPress={() => (queued > 0 ? onError(`${queued} events have not reached the server yet. Sync before forgetting this pairing, or those sales would be stranded.`) : onForget())}
        >
          <Text>Forget pairing</Text>
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

  topbar: { backgroundColor: C.black, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 52, gap: 16 },
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

  body: { flex: 1, flexDirection: 'row' },
  catCol: { width: 140, backgroundColor: '#fff', borderRightWidth: 1, borderRightColor: C.line, paddingVertical: 8 },
  cat: { paddingVertical: 16, paddingHorizontal: 12, marginHorizontal: 8, marginVertical: 3, borderRadius: 8, flexDirection: 'row', justifyContent: 'space-between' },
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
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 8 },
  lineName: { color: C.ink, fontWeight: '600' },
  lineAmt: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
  paperQrText: { fontSize: 20, fontWeight: '800', color: C.ink },
});
