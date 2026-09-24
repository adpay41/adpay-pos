/**
 * Merchant-facing 15.6" sale screen: quick keys → ticket → cash tender → drawer → receipt.
 * Every button calls the SaleSession, which appends events; the ticket shown is the fold of those
 * events. Works fully offline; the sync pill shows what's queued.
 */
import {
  categoryKeys,
  cents,
  favoriteKeys,
  foldSale,
  mulQty,
  quickCashOptions,
  renderReceipt,
  type CatalogItem,
  type CatalogSnapshot,
  type FoldedSale,
  type Permission,
  type ReceiptLine,
} from '@adpay/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DevSettings, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createDisplayChannel, displayFor } from '../core/display';
import { PREVIEW_HEALTH, WebPreviewHardware, type Hardware } from '../core/hardware';
import type { SessionState } from '../core/session';
import type { StaffState } from '../core/staff';
import type { SyncStatus } from '../core/sync';
import type { Runtime } from '../runtime';
import { QuickKey } from './QuickKey';
import { OverridePrompt, SignInScreen } from './StaffUI';
import { C, usd } from './theme';

const FAVORITES = '__favorites__';

type Modal =
  | { kind: 'none' }
  | { kind: 'age'; item: CatalogItem }
  | { kind: 'cash' }
  | { kind: 'done'; sale: FoldedSale; change: number }
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

  const hardware: Hardware = useMemo(
    () =>
      new WebPreviewHardware(
        (lines) => setModal({ kind: 'receipt', lines, title: 'Receipt (printer preview)' }),
        () => {
          setDrawerFlash(true);
          setTimeout(() => setDrawerFlash(false), 1500);
        },
      ),
    [],
  );

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
  const favorites = useMemo(() => favoriteKeys(catalog), [catalog]);
  const items = useMemo(() => (category === FAVORITES ? favorites : categoryKeys(catalog, category)), [catalog, category, favorites]);

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

  const addItem = (item: CatalogItem) => {
    if (item.min_age) setModal({ kind: 'age', item });
    else void run(() => rt.session.addItem(item));
  };

  const receiptFor = (s: FoldedSale, copy: 'original' | 'reprint') =>
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

  async function tender(amount: number) {
    await run(async () => {
      const { sale: done, change } = await rt.session.tenderCash(cents(amount));
      rt.log.info('cash sale completed', { sale: done.sale_id.slice(0, 8), total_cents: done.cash.total_cents, lines: done.lines.length });
      await hardware.kickDrawer();
      await rt.session.recordDrawer('cash_sale', done.sale_id);
      display.publish(displayFor(rt.identity.merchant_name, done, { amount, change }));
      setModal({ kind: 'done', sale: done, change });
      rt.sync.kick();
    });
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
              {c.min_age ? <Text style={[s.catAge, category === c.category_id && { color: '#ddd' }]}>{c.min_age}+</Text> : null}
            </Pressable>
          ))}
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.grid}>
          {items.map((i) => (
            <QuickKey key={i.item_id} item={i} onPress={addItem} />
          ))}
        </ScrollView>

        <View style={s.ticket}>
          <Text style={s.ticketTitle}>{sale ? `Ticket ${sale.sale_id.slice(0, 4).toUpperCase()}` : 'New ticket'}</Text>
          <ScrollView style={{ flex: 1 }}>
            {!sale || sale.lines.length === 0 ? (
              <Text style={s.mutedSmall}>Tap an item to start a sale.</Text>
            ) : (
              sale.lines.map((l) => (
                <View key={l.line_id} style={s.line}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.lineName}>
                      {l.qty > 1 ? `${l.qty} × ` : ''}
                      {l.name}
                    </Text>
                    <Text style={s.mutedSmall}>
                      card {usd(mulQty(l.unit_card_price_cents, l.qty))}
                      {l.min_age ? ` · ${l.min_age}+ checked` : ''}
                      {!l.taxable ? ' · no tax' : ''}
                    </Text>
                  </View>
                  <Text style={s.lineAmt}>{usd(mulQty(l.unit_cash_price_cents, l.qty))}</Text>
                  <Pressable onPress={() => void run(() => rt.session.removeLine(l.line_id))} style={s.remove} accessibilityLabel={`Remove ${l.name}`}>
                    <Text style={s.removeText}>×</Text>
                  </Pressable>
                </View>
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
            <View style={s.actions}>
              <Pressable
                style={[s.payBtn, !sale?.lines.length && s.disabled]}
                disabled={!sale?.lines.length}
                onPress={() => setModal({ kind: 'cash' })}
              >
                <Text style={s.payText}>Cash</Text>
              </Pressable>
              <Pressable style={[s.payBtn, s.disabled]} disabled>
                <Text style={s.payText}>Card</Text>
                <Text style={s.paySub}>terminal: step 6</Text>
              </Pressable>
            </View>
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
                const item = modal.item;
                setModal({ kind: 'none' });
                void run(() => rt.session.addItem(item, { ageConfirmed: true }));
              }}
            >
              <Text style={s.primaryText}>ID checked — {modal.item.min_age}+</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'cash' && sale && (
        <CashModal total={sale.cash.total_cents} onCancel={() => setModal({ kind: 'none' })} onTender={(amt) => void tender(amt)} />
      )}

      {modal.kind === 'done' && (
        <Overlay>
          <Text style={s.modalTitle}>Sale complete</Text>
          <Text style={s.changeLabel}>Change due</Text>
          <Text style={s.changeValue}>{usd(modal.change)}</Text>
          <Text style={s.modalBody}>Total {usd(modal.sale.cash.total_cents)} cash · drawer opened</Text>
          <View style={s.actions}>
            <Pressable style={s.ghost} onPress={() => void finishReceipt(modal.sale, false)}>
              <Text>No receipt</Text>
            </Pressable>
            <Pressable style={s.primary} onPress={() => void finishReceipt(modal.sale, true)}>
              <Text style={s.primaryText}>Print receipt</Text>
            </Pressable>
          </View>
        </Overlay>
      )}

      {modal.kind === 'receipt' && (
        <Overlay onClose={() => setModal({ kind: 'none' })}>
          <Text style={s.modalTitle}>{modal.title}</Text>
          <ScrollView style={s.paper}>
            {modal.lines.map((l, i) => (
              <Text key={i} style={[s.paperLine, l.style === 'bold' && { fontWeight: '800' }, l.style === 'double' && s.paperDouble]}>
                {l.text || ' '}
              </Text>
            ))}
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

function CashModal({ total, onCancel, onTender }: { total: number; onCancel: () => void; onTender: (amount: number) => void }) {
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
        <Pressable style={[s.primary, typed < total && s.disabled]} disabled={typed < total} onPress={() => onTender(typed)}>
          <Text style={s.primaryText}>Take {usd(typed)}</Text>
        </Pressable>
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
});
