/**
 * Ticket lifecycle on the register (build plan P7, Bible 1.1 / 1.3 / 1.6): held tickets to recall;
 * the list of tickets rung here with reprint; refunds by line at the price paid; and voiding a
 * completed sale. Refunds and voids are permission-gated with a manager's PIN in place.
 */
import { mulQty, refundQuote, refundableQty, type FoldedSale, type Permission } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CardRefunder, ParkedTicket, SaleSession } from '../core/session';
import type { StaffGate } from '../core/staff';
import type { EventStore } from '../core/store';
import { OverridePrompt } from './StaffUI';
import { C, usd } from './theme';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function HeldTickets({ session, onRecall, onClose }: { session: SaleSession; onRecall: (saleId: string) => void; onClose: () => void }) {
  const [list, setList] = useState<(ParkedTicket & { sale: FoldedSale })[] | null>(null);
  useEffect(() => {
    void session.parkedTickets().then(setList);
  }, [session]);
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>Held tickets</Text>
      {list?.length === 0 ? <Text style={s.muted}>Nothing on hold.</Text> : null}
      {list?.map((t) => (
        <Pressable key={t.sale_id} style={s.row} onPress={() => onRecall(t.sale_id)}>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{t.label ?? `Ticket ${t.sale_id.slice(0, 4).toUpperCase()}`}</Text>
            <Text style={s.muted}>
              held {time(t.held_at)} · {t.sale.lines.length} {t.sale.lines.length === 1 ? 'item' : 'items'}
            </Text>
          </View>
          <Text style={s.money}>{usd(t.sale.cash.total_cents)}</Text>
          <Text style={s.link}>Recall</Text>
        </Pressable>
      ))}
      <Pressable onPress={onClose} style={s.back}>
        <Text style={s.muted}>Back to the sale</Text>
      </Pressable>
    </View>
  );
}

type Step = { kind: 'list' } | { kind: 'detail'; saleId: string } | { kind: 'approve'; permission: Permission; next: () => Promise<void>; saleId: string };

export function TicketBrowser({
  store,
  session,
  staff,
  cardRefund,
  onReprint,
  onCashBack,
  onClose,
}: {
  store: EventStore;
  session: SaleSession;
  staff: StaffGate;
  /** Puts money back on a card through the processor (P9). */
  cardRefund: CardRefunder;
  onReprint: (sale: FoldedSale) => Promise<void>;
  /** Cash went back to a customer: kick the drawer, print the slip, refresh the drawer. */
  onCashBack: (sale: FoldedSale, amount: number, what: 'refund' | 'void') => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [tickets, setTickets] = useState<{ sale: FoldedSale; at: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const ids = await store.recentSaleIds(40);
    const out: { sale: FoldedSale; at: string }[] = [];
    for (const id of ids) {
      const s = await session.saleById(id);
      const events = await store.eventsForSale(id);
      if (s) out.push({ sale: s, at: events[0]?.occurred_at ?? '' });
    }
    setTickets(out);
  };
  // `load` reads only the stable store and session.
  useEffect(() => {
    void load();
  }, [store, session]);

  const guarded = (permission: Permission, saleId: string, fn: () => Promise<void>) => {
    if (staff.can(permission)) void run(fn);
    else setStep({ kind: 'approve', permission, next: fn, saleId });
  };
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (step.kind === 'approve') {
    return (
      <OverridePrompt
        gate={staff}
        permission={step.permission}
        saleId={step.saleId}
        onCancel={() => setStep({ kind: 'detail', saleId: step.saleId })}
        onApproved={() => {
          setStep({ kind: 'detail', saleId: step.saleId });
          void run(step.next);
        }}
      />
    );
  }

  if (step.kind === 'detail') {
    const t = tickets?.find((x) => x.sale.sale_id === step.saleId);
    if (!t) return null;
    return (
      <TicketDetail
        sale={t.sale}
        at={t.at}
        error={error}
        onBack={() => setStep({ kind: 'list' })}
        onReprint={() => void run(() => onReprint(t.sale))}
        onRefund={(lines, reason) =>
          guarded('sale.refund', t.sale.sale_id, async () => {
            const r = await session.refund(t.sale.sale_id, lines, reason, cardRefund);
            await onCashBack(r.sale, r.amount, 'refund');
          })
        }
        onVoid={() =>
          guarded('sale.void', t.sale.sale_id, async () => {
            const r = await session.voidCompleted(t.sale.sale_id, 'Voided at register', cardRefund);
            await onCashBack(r.sale, r.amount, 'void');
          })
        }
      />
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>Tickets on this register</Text>
      <ScrollView style={{ maxHeight: 460 }}>
        {tickets?.length === 0 ? <Text style={s.muted}>No tickets yet.</Text> : null}
        {tickets?.map(({ sale, at }) => (
          <Pressable key={sale.sale_id} style={s.row} onPress={() => setStep({ kind: 'detail', saleId: sale.sale_id })}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>
                {at ? time(at) : ''} · Ticket {sale.sale_id.slice(0, 4).toUpperCase()}
              </Text>
              <Text style={s.muted}>
                {sale.lines.length} {sale.lines.length === 1 ? 'item' : 'items'} · {sale.status}
                {sale.refunded_cents > 0 && sale.status === 'completed' ? ` · refunded ${usd(sale.refunded_cents)}` : ''}
              </Text>
            </View>
            <Text style={s.money}>{usd(sale.price_mode === 'split' && sale.declared ? sale.declared.total_cents : sale.price_mode === 'card' ? sale.card.total_cents : sale.cash.total_cents)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable onPress={onClose} style={s.back}>
        <Text style={s.muted}>Back to the sale</Text>
      </Pressable>
    </View>
  );
}

function TicketDetail({
  sale,
  at,
  error,
  onBack,
  onReprint,
  onRefund,
  onVoid,
}: {
  sale: FoldedSale;
  at: string;
  error: string | null;
  onBack: () => void;
  onReprint: () => void;
  onRefund: (lines: { line_id: string; qty: number }[], reason: string) => void;
  onVoid: () => void;
}) {
  const left = sale.status === 'completed' ? refundableQty(sale) : {};
  const [pick, setPick] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('Returned');
  const mode = sale.price_mode ?? 'cash';
  const selection = Object.entries(pick)
    .filter(([, q]) => q > 0)
    .map(([line_id, qty]) => ({ line_id, qty }));
  const quote = (() => {
    try {
      return selection.length ? refundQuote(sale, selection).amount_cents : 0;
    } catch {
      return 0;
    }
  })();
  const refundable = sale.status === 'completed' && sale.price_mode !== 'split' && Object.values(left).some((q) => q > 0);

  return (
    <View style={{ gap: 8 }}>
      <Text style={s.title}>Ticket {sale.sale_id.slice(0, 4).toUpperCase()}</Text>
      <Text style={s.muted}>
        {at ? new Date(at).toLocaleString() : ''} · {sale.status} · paid {mode === 'card' ? 'by card' : 'in cash'} {usd(sale.paid_cents)}
        {sale.refunded_cents > 0 ? ` · refunded ${usd(sale.refunded_cents)}` : ''}
      </Text>
      <ScrollView style={{ maxHeight: 300 }}>
        {sale.lines.map((l) => {
          const unit = mode === 'card' ? l.unit_card_price_cents : l.unit_cash_price_cents;
          const can = left[l.line_id] ?? 0;
          const n = pick[l.line_id] ?? 0;
          return (
            <View key={l.line_id} style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>
                  {l.qty > 1 ? `${l.qty} × ` : ''}
                  {l.name}
                </Text>
                {(sale.refunded_qty[l.line_id] ?? 0) > 0 ? <Text style={s.muted}>{sale.refunded_qty[l.line_id]} returned</Text> : null}
              </View>
              <Text style={s.money}>{usd(mulQty(unit, l.qty))}</Text>
              {refundable && can > 0 ? (
                <View style={s.stepper}>
                  <Pressable style={s.step} onPress={() => setPick((p) => ({ ...p, [l.line_id]: Math.max(0, n - 1) }))} accessibilityLabel={`Return one less ${l.name}`}>
                    <Text style={s.stepText}>−</Text>
                  </Pressable>
                  <Text style={s.stepCount}>{n}</Text>
                  <Pressable style={s.step} onPress={() => setPick((p) => ({ ...p, [l.line_id]: Math.min(can, n + 1) }))} accessibilityLabel={`Return one more ${l.name}`}>
                    <Text style={s.stepText}>+</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      {refundable ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {['Returned', 'Damaged', 'Wrong item', 'Price error'].map((r) => (
            <Pressable key={r} onPress={() => setReason(r)} style={[s.chip, reason === r && s.chipOn]}>
              <Text style={[s.chipText, reason === r && { color: '#fff' }]}>{r}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Pressable style={s.ghost} onPress={onReprint}>
          <Text>Reprint</Text>
        </Pressable>
        {refundable ? (
          <Pressable style={[s.ghost, s.dark, quote <= 0 && s.disabled]} disabled={quote <= 0} onPress={() => onRefund(selection, reason)}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{quote > 0 ? `Refund ${usd(quote)} ${mode === 'card' ? 'to card' : 'cash'}` : 'Pick items to refund'}</Text>
          </Pressable>
        ) : null}
        {sale.status === 'completed' ? (
          <Pressable style={s.ghost} onPress={onVoid}>
            <Text>Void sale</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable onPress={onBack} style={s.back}>
        <Text style={s.muted}>‹ All tickets</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  muted: { color: C.muted },
  name: { color: C.ink, fontWeight: '600' },
  money: { color: C.black, fontWeight: '700', fontVariant: ['tabular-nums'] },
  link: { color: C.ink, fontWeight: '700', marginLeft: 8 },
  error: { color: C.amber, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  back: { alignSelf: 'center', padding: 8 },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  // Black, not red: these buttons carry dollar amounts.
  dark: { backgroundColor: C.black, borderColor: C.black },
  disabled: { opacity: 0.4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  stepText: { fontSize: 18, fontWeight: '700', color: C.ink },
  stepCount: { minWidth: 18, textAlign: 'center', fontWeight: '700' },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '600' },
});
