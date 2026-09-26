/**
 * The customer-facing 10.1" screen. Cash and card prices side by side on every line and total,
 * before tender (NJ/NY posted-pricing). In the browser this runs in its own window.
 *
 * P18: the customer picks their language (the receipt follows it), can switch to larger,
 * high-contrast text, and gets a QR for the digital receipt after paying. Every amount has a spoken
 * label for screen readers.
 */
import { isRtl, languageInfo, translator, type Lang } from '@adpay/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createDisplayChannel, type DisplayState } from '../core/display';
import { PhonePad } from './PhonePad';
import { Qr } from './Qr';
import { C, usd } from './theme';

export function CustomerScreen() {
  const channel = useRef(createDisplayChannel()).current;
  const [state, setState] = useState<DisplayState | null>(null);
  const [picking, setPicking] = useState(false);
  const [big, setBig] = useState(false);
  // The number pad (P19a): for rewards on the cart, or "text me my receipt" after paying.
  const [entry, setEntry] = useState<'loyalty' | 'receipt' | null>(null);
  useEffect(() => channel.subscribe(setState), [channel]);
  // Larger text is the customer's own choice: it ends with their sale.
  const phase = state?.phase ?? 'idle';
  useEffect(() => {
    if (phase === 'idle') {
      setBig(false);
      setPicking(false);
      setEntry(null);
    }
  }, [phase]);

  const lang: Lang = state?.language ?? 'en';
  const t = useMemo(() => translator(lang, state?.overrides), [lang, state?.overrides]);
  const s = big ? large : standard;
  const dir = { direction: isRtl(lang) ? 'rtl' : 'ltr' } as const;
  const languages = state?.languages ?? ['en'];

  const corner = (
    <View style={s.corner}>
      {languages.length > 1 && (
        <Pressable style={s.chip} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel={`${t('language')}: ${languageInfo(lang).native}`}>
          <Text style={s.chipText}>🌐 {languageInfo(lang).native}</Text>
        </Pressable>
      )}
      <Pressable style={s.chip} onPress={() => setBig((b) => !b)} accessibilityRole="button" accessibilityState={{ selected: big }}>
        <Text style={s.chipText}>{big ? t('standard_text') : t('larger_text')}</Text>
      </Pressable>
    </View>
  );

  if (entry && state) {
    return (
      <View style={[s.root, dir]}>
        <PhonePad
          t={t}
          big={big}
          title={entry === 'loyalty' ? t('earn_rewards') : t('text_me_receipt')}
          askConsent={entry === 'loyalty' && !!state.loyalty?.ask_texts}
          storeName={state.merchant_name}
          onCancel={() => setEntry(null)}
          onDone={(phone, optIn) => {
            channel.send({ kind: 'customer_phone', purpose: entry, phone, marketing_opt_in: entry === 'loyalty' && optIn });
            setEntry(null);
          }}
        />
      </View>
    );
  }

  if (picking) {
    return (
      <View style={[s.root, s.center, dir]}>
        <Text style={s.pickTitle} accessibilityRole="header">
          {t('choose_language')}
        </Text>
        <View style={s.pickGrid}>
          {languages.map((code) => (
            <Pressable
              key={code}
              style={[s.pickBtn, code === lang && s.pickOn]}
              onPress={() => {
                channel.send({ kind: 'customer_language', language: code });
                setPicking(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${languageInfo(code).native} (${languageInfo(code).name})`}
            >
              <Text style={[s.pickText, code === lang && s.pickTextOn]}>{languageInfo(code).native}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  if (!state || state.phase === 'idle') {
    return (
      <View style={[s.root, s.center, dir]}>
        {corner}
        <Text style={s.brand} accessibilityLabel="AD Pay">
          <Text style={s.mark}> AD </Text> Pay
        </Text>
        <Text style={s.welcome}>{state?.merchant_name ?? t('welcome')}</Text>
        <Text style={s.muted}>{t('welcome_note')}</Text>
        {/* Deals of the day (P20a): the store's running promotions, as it wrote them. */}
        {state?.deals.length ? (
          <View style={s.deals} accessibilityRole="summary">
            {state.deals.map((d) => (
              <Text key={d} style={s.deal}>
                ★ {d}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  if (state.phase === 'paid') {
    return (
      <View style={[s.root, s.center, dir]}>
        {corner}
        <Text style={s.thanks} accessibilityRole="header">
          {t('thanks')}
        </Text>
        <Text style={s.paid}>
          {t('paid')} {usd(state.paid_cents ?? 0)}
        </Text>
        {state.change_cents ? (
          <Text style={s.change} accessibilityLiveRegion="polite">
            {t('your_change')} {usd(state.change_cents)}
          </Text>
        ) : null}
        {state.receipt_url ? (
          <View style={s.qrBox}>
            <Qr value={state.receipt_url} size={big ? 300 : 240} label={t('scan_receipt')} />
            <Text style={s.qrText}>{t('scan_receipt')}</Text>
            {/* …or by text (P19a). Until texting is connected, the screen says so rather than pretend. */}
            {state.receipt_text === null ? (
              <Pressable style={s.chip} onPress={() => setEntry('receipt')} accessibilityRole="button">
                <Text style={s.chipText}>{t('text_me_receipt')}</Text>
              </Pressable>
            ) : (
              <Text style={s.muted} accessibilityLiveRegion="polite">
                {state.receipt_text === 'sent' ? t('receipt_texted') : state.receipt_text === 'not_delivered' ? t('receipt_not_texted') : t('receipt_text_failed')}
              </Text>
            )}
          </View>
        ) : null}
      </View>
    );
  }

  // Card: a still, clear instruction. No processor name, no spinner (Bible Part 4).
  if (state.phase === 'card' || state.phase === 'approved' || state.phase === 'declined') {
    return (
      <View style={[s.root, s.center, dir]}>
        {corner}
        {state.paid_so_far_cents ? (
          <Text style={s.muted}>
            {t('paid_so_far')} {usd(state.paid_so_far_cents)}
          </Text>
        ) : null}
        <Text style={s.cardLabel}>{t('card_amount')}</Text>
        <Text style={s.cardAmount} accessibilityLabel={`${t('card_amount')} ${usd(state.card_amount_cents ?? 0)}`}>
          {usd(state.card_amount_cents ?? 0)}
        </Text>
        <View accessibilityLiveRegion="polite">
          {state.phase === 'card' ? <Text style={s.cardPrompt}>{t('tap_card')}</Text> : null}
          {state.phase === 'approved' ? <Text style={s.approved}>{t('approved')}</Text> : null}
          {state.phase === 'declined' ? <Text style={s.declined}>{t('declined')}</Text> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, dir]}>
      <View style={s.head}>
        <Text style={s.headText}>{state.merchant_name}</Text>
        {corner}
      </View>
      <View style={s.colsHead}>
        <Text style={[s.colName, s.colLabel]}>{t('col_item')}</Text>
        <Text style={[s.colPrice, s.colLabel]}>{t('col_cash')}</Text>
        <Text style={[s.colPrice, s.colLabel]}>{t('col_card')}</Text>
      </View>
      <ScrollView style={{ flex: 1 }}>
        {state.lines.map((l) => (
          <View
            key={l.line_id}
            style={s.row}
            accessible
            accessibilityLabel={`${l.qty > 1 ? `${l.qty} × ` : ''}${l.name}. ${t('col_cash')} ${usd(l.cash_cents)}. ${t('col_card')} ${usd(l.card_cents)}.`}
          >
            <View style={{ flex: 1 }}>
              <Text style={[s.colName, { flex: 0 }]} numberOfLines={2}>
                {l.qty > 1 ? `${l.qty} × ` : ''}
                {l.name}
              </Text>
              {l.deal ? <Text style={s.lineDeal}>★ {l.deal.kind === 'promo' ? l.deal.name : t('r_reward')}</Text> : null}
            </View>
            <Text style={s.colPrice}>{usd(l.cash_cents)}</Text>
            <Text style={[s.colPrice, s.cardCol]}>{usd(l.card_cents)}</Text>
          </View>
        ))}
      </ScrollView>
      {state.loyalty ? (
        <View style={s.loyalty} accessibilityLiveRegion="polite">
          {state.loyalty.last4 === null ? (
            <Pressable style={s.loyaltyButton} onPress={() => setEntry('loyalty')} accessibilityRole="button">
              <Text style={s.loyaltyButtonText}>★ {t('earn_rewards')}</Text>
            </Pressable>
          ) : (
            <Text style={s.loyaltyText}>
              {t('phone_ending', { last4: state.loyalty.last4 })} ·{' '}
              {state.loyalty.redeemed
                ? t('reward_applied')
                : state.loyalty.status
                  ? state.loyalty.status.rewards_available > 0
                    ? t('reward_ready')
                    : state.loyalty.status.kind === 'visits'
                      ? t('visits_progress', { count: state.loyalty.status.balance, needed: state.loyalty.status.needed, to_next: state.loyalty.status.to_next })
                      : t('points_progress', { count: state.loyalty.status.balance, to_next: state.loyalty.status.to_next })
                  : state.loyalty.offline
                    ? t('loyalty_offline')
                    : '…'}
            </Text>
          )}
        </View>
      ) : null}
      <View style={s.totals}>
        <View style={s.totalBox} accessible accessibilityLabel={`${t('pay_cash')}: ${usd(state.cash_total_cents)}, ${t('incl_tax', { amount: usd(state.tax_cash_cents) })}`}>
          <Text style={s.totalLabel}>{t('pay_cash')}</Text>
          <Text style={s.totalValue}>{usd(state.cash_total_cents)}</Text>
          <Text style={s.mutedSmall}>{t('incl_tax', { amount: usd(state.tax_cash_cents) })}</Text>
        </View>
        <View style={s.totalBox} accessible accessibilityLabel={`${t('pay_card')}: ${usd(state.card_total_cents)}, ${t('incl_tax', { amount: usd(state.tax_card_cents) })}`}>
          <Text style={s.totalLabel}>{t('pay_card')}</Text>
          <Text style={s.totalValue}>{usd(state.card_total_cents)}</Text>
          <Text style={s.mutedSmall}>{t('incl_tax', { amount: usd(state.tax_card_cents) })}</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Standard, and larger + high-contrast (Bible 1.5 accessibility): 1.35× type, pure black text,
 * black rules, a darker green that still reads as "money received".
 */
function makeStyles(big: boolean) {
  const k = big ? 1.35 : 1;
  const f = (n: number) => Math.round(n * k);
  const soft = big ? '#000' : C.muted;
  const line = big ? '#000' : C.line;
  const green = big ? '#05602f' : C.green;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: '#fff' },
    center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    corner: { position: 'absolute', top: 12, end: 12, flexDirection: 'row', gap: 8, zIndex: 2 },
    chip: { borderWidth: big ? 2 : 1, borderColor: big ? '#000' : C.line, backgroundColor: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
    chipText: { fontSize: f(16), fontWeight: '700', color: C.ink },
    brand: { fontSize: f(44), fontWeight: '800', color: C.ink },
    mark: { backgroundColor: C.red, color: '#fff' },
    welcome: { fontSize: f(26), fontWeight: '600', color: C.ink, textAlign: 'center' },
    muted: { color: soft, fontSize: f(16), textAlign: 'center' },
    mutedSmall: { color: soft, fontSize: f(13) },
    thanks: { fontSize: f(48), fontWeight: '800', color: green },
    cardLabel: { fontSize: f(20), color: soft, fontWeight: '700' },
    cardAmount: { fontSize: f(64), fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
    cardPrompt: { fontSize: f(26), fontWeight: '700', color: C.ink, textAlign: 'center', maxWidth: 640 },
    approved: { fontSize: f(32), fontWeight: '800', color: green },
    // Declined is ink, not red: it sits right under an amount.
    declined: { fontSize: f(24), fontWeight: '700', color: C.ink, textAlign: 'center', maxWidth: 640 },
    paid: { fontSize: f(28), color: C.ink },
    change: { fontSize: f(32), fontWeight: '700', color: green },
    qrBox: { alignItems: 'center', gap: 8, marginTop: 8 },
    qrText: { fontSize: f(18), fontWeight: '700', color: C.ink },
    head: { backgroundColor: C.black, padding: 16, minHeight: 64, justifyContent: 'center' },
    headText: { color: '#fff', fontSize: f(20), fontWeight: '700' },
    colsHead: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: big ? 2 : 1, borderBottomColor: line },
    colLabel: { color: soft, fontSize: f(13), fontWeight: '700', textTransform: 'uppercase' },
    row: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: big ? 2 : 1, borderBottomColor: line, alignItems: 'center' },
    colName: { flex: 1, fontSize: f(20), color: C.ink, textAlign: 'auto' },
    colPrice: { width: big ? 160 : 120, textAlign: 'right', fontSize: f(20), fontWeight: '600', color: C.black, fontVariant: ['tabular-nums'] },
    cardCol: { color: big ? '#000' : C.muted },
    totals: { flexDirection: 'row', gap: 16, padding: 20, borderTopWidth: 2, borderTopColor: C.black },
    totalBox: { flex: 1, backgroundColor: big ? '#fff' : C.ground, borderWidth: big ? 2 : 0, borderColor: '#000', borderRadius: 12, padding: 16 },
    totalLabel: { fontSize: f(16), color: soft, fontWeight: '700' },
    totalValue: { fontSize: f(40), fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
    loyalty: { paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: big ? 2 : 1, borderTopColor: line, alignItems: 'center' },
    loyaltyButton: { borderWidth: 2, borderColor: C.black, borderRadius: 24, paddingHorizontal: 18, paddingVertical: 10 },
    loyaltyButtonText: { fontSize: f(18), fontWeight: '800', color: C.ink },
    loyaltyText: { fontSize: f(18), fontWeight: '700', color: C.ink, textAlign: 'center' },
    deals: { marginTop: 18, gap: 8, alignItems: 'center' },
    deal: { fontSize: f(22), fontWeight: '800', color: C.ink, textAlign: 'center' },
    lineDeal: { fontSize: f(14), fontWeight: '700', color: green },
    pickTitle: { fontSize: f(30), fontWeight: '800', color: C.ink },
    pickGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, maxWidth: 760 },
    pickBtn: { minWidth: 200, paddingVertical: 18, paddingHorizontal: 20, borderRadius: 12, borderWidth: 2, borderColor: C.black, backgroundColor: '#fff', alignItems: 'center' },
    pickOn: { backgroundColor: C.black },
    pickText: { fontSize: f(26), fontWeight: '700', color: C.ink },
    pickTextOn: { color: '#fff' },
  });
}

const standard = makeStyles(false);
const large = makeStyles(true);
