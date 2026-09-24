/**
 * Drawer panel (build plan P6, Bible 1.2): start the drawer with a counted float; safe drops,
 * paid-outs (vendor paid from the drawer — "huge in bodegas") and paid-ins with a reason; no sale;
 * and the blind close. The cashier enters the count before seeing what was expected. Over/short is
 * shown after, never in red (amber for short, black for over).
 */
import { CASH_MOVEMENT_KINDS, DENOMINATIONS, cents, denominationTotal, formatUsd, type CashMovementKind, type Cents, type DrawerSession, type Permission } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DrawerManager } from '../core/drawer';
import type { StaffGate } from '../core/staff';
import { takeCountPhoto } from './countPhoto';
import { NumberPad } from './SpeedUI';
import { OverridePrompt } from './StaffUI';
import { C, usd } from './theme';

const REASONS: Record<CashMovementKind, string[]> = {
  drop: ['Safe drop'],
  paid_out: ['Vendor delivery', 'Store supplies', 'Lottery payout', 'Other'],
  paid_in: ['Change from bank', 'Owner added cash', 'Other'],
};
const PERMISSION: Record<CashMovementKind, Permission> = { drop: 'cash.drop', paid_out: 'cash.paid_out', paid_in: 'cash.paid_out' };

type Step =
  | { kind: 'home' }
  | { kind: 'float' }
  | { kind: 'amount'; move: CashMovementKind }
  | { kind: 'reason'; move: CashMovementKind; amount: Cents }
  | { kind: 'approve'; permission: Permission; next: () => Promise<void> }
  | { kind: 'count' }
  | { kind: 'counterfeit' }
  | { kind: 'result'; session: DrawerSession };

export function DrawerPanel({
  drawer,
  staff,
  session,
  startWithFloat,
  startWithCounterfeit,
  uploadPhoto,
  onHandover,
  kick,
  onStarted,
  onClose,
}: {
  drawer: DrawerManager;
  staff: StaffGate;
  session: DrawerSession | null;
  /** Opened from the Cash button with no drawer started: go straight to the float count. */
  startWithFloat?: boolean;
  /** Opened from the cash tender to refuse a bill (P15). */
  startWithCounterfeit?: boolean;
  /** Upload the count-sheet photo (online only); null when there's no way to (P15). */
  uploadPhoto?: ((blob: Blob) => Promise<string>) | null;
  /** After a handover close: sign the outgoing cashier out (and off the clock). */
  onHandover?: () => void;
  kick: () => Promise<void>;
  onStarted?: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(startWithFloat ? { kind: 'float' } : startWithCounterfeit ? { kind: 'counterfeit' } : { kind: 'home' });
  const [error, setError] = useState<string | null>(null);
  const name = (id: string | null) => staff.members().find((m) => m.user_id === id)?.name ?? 'someone';
  // Only people who may see sales figures see what the drawer should hold; everyone else counts blind.
  const seesExpected = staff.can('reports.view');

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const guarded = (permission: Permission, fn: () => Promise<void>) => {
    if (staff.can(permission)) void run(fn);
    else setStep({ kind: 'approve', permission, next: fn });
  };

  if (step.kind === 'approve') {
    return (
      <OverridePrompt
        gate={staff}
        permission={step.permission}
        saleId={null}
        onCancel={() => setStep({ kind: 'home' })}
        onApproved={() => {
          setStep({ kind: 'home' });
          void run(step.next);
        }}
      />
    );
  }
  if (step.kind === 'float') {
    return (
      <NumberPad
        title="Count the starting cash"
        subtitle="What’s in the drawer before the first sale (the float)."
        money
        max={10_000_00}
        confirmLabel={(c) => `Start drawer with ${usd(c)}`}
        onCancel={startWithFloat ? onClose : () => setStep({ kind: 'home' })}
        onConfirm={(c) =>
          void run(async () => {
            await drawer.start(c as Cents);
            if (onStarted) onStarted();
            else setStep({ kind: 'home' });
          })
        }
      />
    );
  }
  if (step.kind === 'amount') {
    const k = CASH_MOVEMENT_KINDS[step.move];
    return (
      <NumberPad
        title={k.label}
        subtitle={k.hint}
        money
        max={10_000_00}
        confirmLabel={(c) => `Next — ${usd(c)}`}
        onCancel={() => setStep({ kind: 'home' })}
        onConfirm={(c) => setStep({ kind: 'reason', move: step.move, amount: c as Cents })}
      />
    );
  }
  if (step.kind === 'reason') return <ReasonStep move={step.move} amount={step.amount} error={error} onBack={() => setStep({ kind: 'home' })} onSave={(reason, payee) =>
    void run(async () => {
      await drawer.move(step.move, step.amount, reason, payee);
      await kick();
      setStep({ kind: 'home' });
    })
  } />;
  if (step.kind === 'count') {
    return (
      <CountStep
        error={error}
        uploadPhoto={uploadPhoto ?? null}
        onCancel={() => setStep({ kind: 'home' })}
        onClose={(counted, opts) =>
          void run(async () => {
            const closed = await drawer.close(counted, opts);
            setStep({ kind: 'result', session: closed });
          })
        }
      />
    );
  }
  if (step.kind === 'counterfeit') {
    return (
      <CounterfeitStep
        error={error}
        onBack={() => (startWithCounterfeit ? onClose() : setStep({ kind: 'home' }))}
        onFlag={(denom, note) =>
          void run(async () => {
            await drawer.flagCounterfeit(denom, note);
            await kick();
            if (startWithCounterfeit) onClose();
            else setStep({ kind: 'home' });
          })
        }
      />
    );
  }
  if (step.kind === 'result') {
    const os = step.session.over_short_cents ?? 0;
    return (
      <View style={{ gap: 10 }}>
        <Text style={s.title}>Drawer closed</Text>
        <Row label="Counted" value={usd(step.session.counted_cents ?? 0)} />
        <Row label="Expected" value={usd(step.session.expected_cents)} />
        <Text style={[s.result, os < 0 ? s.short : s.even]}>
          {os === 0 ? 'Right on the money.' : os < 0 ? `Short ${formatUsd((-os) as Cents)}` : `Over ${usd(os)}`}
        </Text>
        <Text style={s.muted}>Recorded for {name(step.session.closed_by)}. The owner sees this in the merchant app.</Text>
        {step.session.handover ? <Text style={s.body}>Handed over: the next shift starts with {usd(step.session.counted_cents ?? 0)} in the drawer. Next cashier, sign in.</Text> : null}
        <Pressable
          style={s.primary}
          onPress={() => {
            if (step.session.handover) onHandover?.();
            onClose();
          }}
        >
          <Text style={s.primaryText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  // Home
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>Drawer</Text>
      {!session ? (
        <>
          <Text style={s.body}>The drawer isn’t started. Count the starting cash to begin taking cash.</Text>
          <Pressable style={s.primary} onPress={() => setStep({ kind: 'float' })}>
            <Text style={s.primaryText}>Start drawer</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={s.muted}>
            Started {new Date(session.opened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} by {name(session.opened_by)} with {usd(session.float_cents)}
          </Text>
          <View style={s.grid}>
            <Stat label="Cash sales" value={`${session.cash_sale_count}`} />
            <Stat label="Drops" value={usd(session.drops_cents)} />
            <Stat label="Paid out" value={usd(session.paid_out_cents)} />
            <Stat label="Paid in" value={usd(session.paid_in_cents)} />
            {seesExpected ? <Stat label="Should hold" value={usd(session.expected_cents)} /> : null}
          </View>
          {session.movements.length ? (
            <View>
              {session.movements.slice(-4).map((m) => (
                <Text key={m.movement_id} style={s.muted}>
                  {CASH_MOVEMENT_KINDS[m.kind].label} {usd(m.amount_cents)} — {m.reason}
                </Text>
              ))}
            </View>
          ) : null}
          <View style={s.row}>
            {(Object.keys(CASH_MOVEMENT_KINDS) as CashMovementKind[]).map((k) => (
              <Pressable key={k} style={s.ghost} onPress={() => guarded(PERMISSION[k], async () => setStep({ kind: 'amount', move: k }))}>
                <Text>{CASH_MOVEMENT_KINDS[k].label}</Text>
              </Pressable>
            ))}
            <Pressable style={s.ghost} onPress={() => setStep({ kind: 'counterfeit' })}>
              <Text>Counterfeit bill</Text>
            </Pressable>
            <Pressable
              style={s.ghost}
              onPress={() =>
                guarded('drawer.no_sale', async () => {
                  await drawer.noSale();
                  await kick();
                })
              }
            >
              <Text>No sale</Text>
            </Pressable>
          </View>
          <Pressable style={s.primary} onPress={() => setStep({ kind: 'count' })}>
            <Text style={s.primaryText}>Close & count drawer</Text>
          </Pressable>
        </>
      )}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Pressable onPress={onClose} style={{ alignSelf: 'center', padding: 8 }}>
        <Text style={s.muted}>Back to the sale</Text>
      </Pressable>
    </View>
  );
}

function ReasonStep({ move, amount, error, onBack, onSave }: { move: CashMovementKind; amount: Cents; error: string | null; onBack: () => void; onSave: (reason: string, payee: string | null) => void }) {
  const [reason, setReason] = useState(REASONS[move][0]!);
  const [other, setOther] = useState('');
  const [payee, setPayee] = useState('');
  const text = reason === 'Other' ? other : reason;
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>
        {CASH_MOVEMENT_KINDS[move].label} — {usd(amount)}
      </Text>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {REASONS[move].map((r) => (
          <Pressable key={r} onPress={() => setReason(r)} style={[s.chip, reason === r && s.chipOn]}>
            <Text style={[s.chipText, reason === r && { color: '#fff' }]}>{r}</Text>
          </Pressable>
        ))}
      </View>
      {reason === 'Other' ? <TextInput style={s.input} value={other} onChangeText={setOther} placeholder="What was it for?" maxLength={200} /> : null}
      {move === 'paid_out' ? <TextInput style={s.input} value={payee} onChangeText={setPayee} placeholder="Paid to (e.g. Stella Bakery)" maxLength={120} /> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onBack}>
          <Text>Cancel</Text>
        </Pressable>
        <Pressable style={[s.primary, s.black, !text.trim() && s.disabled]} disabled={!text.trim()} onPress={() => onSave(text, move === 'paid_out' ? payee : null)}>
          <Text style={s.primaryText}>Open drawer & record</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The blind close (P15): the total, or bill by bill and coin by coin (the total is theirs, not the
 * expected amount); a photo of the count sheet; and "hand over": the next shift starts with this cash.
 */
function CountStep({
  error,
  uploadPhoto,
  onCancel,
  onClose,
}: {
  error: string | null;
  uploadPhoto: ((blob: Blob) => Promise<string>) | null;
  onCancel: () => void;
  onClose: (counted: Cents, opts: { denominations: Record<string, number> | null; photo_media_id: string | null; handover: boolean }) => void;
}) {
  const [mode, setMode] = useState<'total' | 'denoms'>('total');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<{ id: string | null; busy: boolean; note: string | null }>({ id: null, busy: false, note: null });
  const [handover, setHandover] = useState(false);
  const numeric = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0]));
  const total = denominationTotal(numeric);

  async function snap() {
    if (!uploadPhoto) return;
    setPhoto({ id: null, busy: true, note: null });
    try {
      const blob = await takeCountPhoto();
      if (!blob) return setPhoto({ id: null, busy: false, note: null });
      setPhoto({ id: await uploadPhoto(blob), busy: false, note: 'Photo attached' });
    } catch (e) {
      setPhoto({ id: null, busy: false, note: `No photo: ${(e as Error).message}` });
    }
  }

  const extras = (
    <View style={{ gap: 8 }}>
      <View style={s.row}>
        {uploadPhoto ? (
          <Pressable style={s.ghost} onPress={() => void snap()} disabled={photo.busy}>
            <Text>{photo.busy ? 'Uploading…' : photo.id ? '✓ Photo of count sheet' : 'Photo of count sheet'}</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.ghost, handover && s.chipOn]} onPress={() => setHandover((h) => !h)}>
          <Text style={handover ? { color: '#fff' } : undefined}>{handover ? '✓ Hand over to next cashier' : 'Hand over to next cashier'}</Text>
        </Pressable>
      </View>
      {photo.note ? <Text style={s.muted}>{photo.note}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={{ gap: 10 }}>
      <View style={s.row}>
        {(['total', 'denoms'] as const).map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[s.chip, mode === m && s.chipOn]}>
            <Text style={[s.chipText, mode === m && { color: '#fff' }]}>{m === 'total' ? 'Enter the total' : 'Count bills & coins'}</Text>
          </Pressable>
        ))}
      </View>
      {mode === 'total' ? (
        <>
          <NumberPad
            title="Count the drawer"
            subtitle="Count everything in the drawer and enter the total. You’ll see the result after."
            money
            max={100_000_00}
            confirmLabel={(c) => `Close with ${usd(c)} counted`}
            onCancel={onCancel}
            onConfirm={(c) => onClose(c as Cents, { denominations: null, photo_media_id: photo.id, handover })}
          />
          {extras}
        </>
      ) : (
        <>
          <Text style={s.title}>Count bills & coins</Text>
          <View style={s.grid}>
            {DENOMINATIONS.map((d) => (
              <View key={d.cents} style={s.denom}>
                <Text style={s.statLabel}>{d.label}</Text>
                <TextInput
                  style={s.input}
                  value={counts[String(d.cents)] ?? ''}
                  onChangeText={(v) => setCounts((c) => ({ ...c, [String(d.cents)]: v.replace(/[^0-9]/g, '').slice(0, 5) }))}
                  keyboardType="number-pad"
                  placeholder="0"
                  accessibilityLabel={`Number of ${d.label}`}
                />
              </View>
            ))}
          </View>
          <Text style={s.statValue}>Counted {usd(total)}</Text>
          {extras}
          <View style={s.row}>
            <Pressable style={s.ghost} onPress={onCancel}>
              <Text>Cancel</Text>
            </Pressable>
            <Pressable style={[s.primary, total <= 0 && s.disabled]} disabled={total <= 0} onPress={() => onClose(cents(total), { denominations: numeric, photo_media_id: photo.id, handover })}>
              <Text style={s.primaryText}>Close with {usd(total)} counted</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

/** Refuse a bill as counterfeit (P15, Bible 1.2): which note, an optional note; logged, drawer stays shut. */
function CounterfeitStep({ error, onBack, onFlag }: { error: string | null; onBack: () => void; onFlag: (denominationCents: number, note: string | null) => void }) {
  const bills = DENOMINATIONS.filter((d) => d.kind === 'bill' && d.cents !== 200);
  const [denom, setDenom] = useState(2_000);
  const [note, setNote] = useState('');
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.title}>Counterfeit bill</Text>
      <Text style={s.body}>Don’t take it. Hand it back and ask for another payment. This logs which note, when and who, for the owner.</Text>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {bills.map((b) => (
          <Pressable key={b.cents} onPress={() => setDenom(b.cents)} style={[s.chip, denom === b.cents && s.chipOn]}>
            <Text style={[s.chipText, denom === b.cents && { color: '#fff' }]}>{b.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput style={s.input} value={note} onChangeText={setNote} placeholder="Note (optional): what gave it away, the customer" maxLength={200} />
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={s.ghost} onPress={onBack}>
          <Text>Cancel</Text>
        </Pressable>
        <Pressable style={[s.primary, s.black]} onPress={() => onFlag(denom, note || null)}>
          <Text style={s.primaryText}>Log refused bill</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: C.ink },
  body: { fontSize: 16, color: C.ink },
  muted: { color: C.muted },
  error: { color: C.amber, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, minWidth: 110, backgroundColor: C.ground, borderRadius: 8, padding: 10 },
  statLabel: { fontSize: 12, color: C.muted, fontWeight: '700' },
  statValue: { fontSize: 18, fontWeight: '800', color: C.black, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 8 },
  ghost: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center', backgroundColor: '#fff' },
  primary: { backgroundColor: C.red, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', flexGrow: 1 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.4 },
  black: { backgroundColor: C.black },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '600' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  denom: { width: 96, gap: 4 },
  // Over/short: amber when short, black when even or over — never red near an amount.
  result: { fontSize: 28, fontWeight: '800' },
  short: { color: C.amber },
  even: { color: C.black },
});
