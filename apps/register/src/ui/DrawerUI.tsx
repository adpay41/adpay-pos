/**
 * Drawer panel (build plan P6, Bible 1.2): start the drawer with a counted float; safe drops,
 * paid-outs (vendor paid from the drawer — "huge in bodegas") and paid-ins with a reason; no sale;
 * and the blind close. The cashier enters the count before seeing what was expected. Over/short is
 * shown after, never in red (amber for short, black for over).
 */
import { CASH_MOVEMENT_KINDS, formatUsd, type CashMovementKind, type Cents, type DrawerSession, type Permission } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DrawerManager } from '../core/drawer';
import type { StaffGate } from '../core/staff';
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
  | { kind: 'result'; session: DrawerSession };

export function DrawerPanel({
  drawer,
  staff,
  session,
  startWithFloat,
  kick,
  onStarted,
  onClose,
}: {
  drawer: DrawerManager;
  staff: StaffGate;
  session: DrawerSession | null;
  /** Opened from the Cash button with no drawer started: go straight to the float count. */
  startWithFloat?: boolean;
  kick: () => Promise<void>;
  onStarted?: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(startWithFloat ? { kind: 'float' } : { kind: 'home' });
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
      <NumberPad
        title="Count the drawer"
        subtitle="Count everything in the drawer and enter the total. You’ll see the result after."
        money
        max={100_000_00}
        confirmLabel={(c) => `Close with ${usd(c)} counted`}
        onCancel={() => setStep({ kind: 'home' })}
        onConfirm={(c) =>
          void run(async () => {
            const closed = await drawer.close(c as Cents);
            setStep({ kind: 'result', session: closed });
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
        <Pressable style={s.primary} onPress={onClose}>
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
  // Over/short: amber when short, black when even or over — never red near an amount.
  result: { fontSize: 28, fontWeight: '800' },
  short: { color: C.amber },
  even: { color: C.black },
});
