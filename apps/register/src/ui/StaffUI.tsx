/**
 * Register sign-in and manager override (build plan P3). One PIN pad for both: tap a name, type
 * the PIN, Enter. The PIN never leaves this component except into StaffGate, which checks it
 * against the hash on the device and forgets it.
 */
import { PERMISSIONS, type Permission, type RegisterStaffMember } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PinError, type StaffGate } from '../core/staff';
import { C } from './theme';

const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier' } as const;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function PeopleGrid({ people, onPick, lockedFor }: { people: RegisterStaffMember[]; onPick: (m: RegisterStaffMember) => void; lockedFor: (id: string) => number }) {
  return (
    <View style={s.people}>
      {people.map((m) => {
        const locked = lockedFor(m.user_id) > 0;
        return (
          <Pressable key={m.user_id} onPress={() => onPick(m)} style={[s.person, locked && { opacity: 0.45 }]} accessibilityRole="button" accessibilityLabel={`${m.name}, ${ROLE_LABEL[m.role]}`}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{initials(m.name)}</Text>
            </View>
            <Text style={s.personName} numberOfLines={1}>
              {m.name}
            </Text>
            <Text style={s.personRole}>{locked ? 'locked' : ROLE_LABEL[m.role]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Masked PIN entry with a 0–9 keypad. Calls `onSubmit` with the digits; shows its error. */
export function PinPad({ title, subtitle, onSubmit, onBack }: { title: string; subtitle?: string; onSubmit: (pin: string) => Promise<void>; onBack: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const press = (k: string) => {
    setError(null);
    setPin((p) => (k === '⌫' ? p.slice(0, -1) : (p + k).slice(0, 6)));
  };
  async function enter() {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      await onSubmit(pin);
    } catch (e) {
      setError(e instanceof PinError || e instanceof Error ? e.message : 'Try again');
      setPin('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.padWrap}>
      <Text style={s.padTitle}>{title}</Text>
      {subtitle ? <Text style={s.muted}>{subtitle}</Text> : null}
      <View style={s.dots} accessibilityLabel={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <View key={i} style={[s.dot, i < pin.length && s.dotOn]} />
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : <Text style={s.errorSpace}> </Text>}
      <View style={s.keys}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'Enter'].map((k) => (
          <Pressable
            key={k}
            onPress={() => (k === 'Enter' ? void enter() : press(k))}
            style={[s.key, k === 'Enter' && s.enter, k === 'Enter' && (pin.length < 4 || busy) && { opacity: 0.4 }]}
            accessibilityLabel={k === '⌫' ? 'Delete' : k}
          >
            <Text style={[s.keyText, k === 'Enter' && { color: '#fff', fontSize: 18 }]}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onBack} style={s.back}>
        <Text style={s.muted}>‹ Back</Text>
      </Pressable>
    </View>
  );
}

/** Full-screen "who's working?" shown whenever nobody is signed in. */
export function SignInScreen({ gate, storeName }: { gate: StaffGate; storeName: string }) {
  const [who, setWho] = useState<RegisterStaffMember | null>(null);
  return (
    <View style={s.screen}>
      <Text style={s.brand}>
        <Text style={s.mark}> AD </Text> Pay
      </Text>
      <Text style={s.store}>{storeName}</Text>
      {!who ? (
        <>
          <Text style={s.h1}>Who’s working?</Text>
          <PeopleGrid
            people={gate.members()}
            lockedFor={(id) => gate.lockedFor(id)}
            onPick={setWho}
          />
        </>
      ) : (
        <PinPad title={`Hi ${who.name.split(' ')[0]} — enter your PIN`} onBack={() => setWho(null)} onSubmit={async (pin) => void (await gate.signIn(who.user_id, pin))} />
      )}
    </View>
  );
}

/**
 * Manager override: the signed-in person can't do `permission`; someone who can approves with their
 * own PIN. Resolves the overlay by calling `onApproved` after the override event is recorded.
 */
export function OverridePrompt({
  gate,
  permission,
  saleId,
  onApproved,
  onCancel,
}: {
  gate: StaffGate;
  permission: Permission;
  saleId: string | null;
  onApproved: () => void;
  onCancel: () => void;
}) {
  const approvers = gate.approvers(permission);
  const [who, setWho] = useState<RegisterStaffMember | null>(approvers.length === 1 ? approvers[0]! : null);
  const label = PERMISSIONS[permission].label;
  if (approvers.length === 0) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={s.padTitle}>Needs approval: {label}</Text>
        <Text style={s.muted}>Nobody set up on this register can approve this. The owner can change who may do it in the merchant app (Staff → Permissions).</Text>
        <Pressable onPress={onCancel} style={s.back}>
          <Text style={s.muted}>OK</Text>
        </Pressable>
      </View>
    );
  }
  return !who ? (
    <View style={{ gap: 10 }}>
      <Text style={s.padTitle}>Manager approval: {label}</Text>
      <Text style={s.muted}>Who’s approving?</Text>
      <PeopleGrid people={approvers} lockedFor={(id) => gate.lockedFor(id)} onPick={setWho} />
      <Pressable onPress={onCancel} style={s.back}>
        <Text style={s.muted}>Cancel</Text>
      </Pressable>
    </View>
  ) : (
    <PinPad
      title={`${who.name}: approve “${label}”`}
      subtitle="Enter your PIN"
      onBack={() => (approvers.length === 1 ? onCancel() : setWho(null))}
      onSubmit={async (pin) => {
        await gate.override(permission, who.user_id, pin, saleId);
        onApproved();
      }}
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14, backgroundColor: C.ground },
  brand: { fontSize: 22, fontWeight: '800', color: C.black },
  mark: { backgroundColor: C.red, color: '#fff' },
  store: { color: C.muted, fontWeight: '600' },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink, marginTop: 8 },
  muted: { color: C.muted },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center', maxWidth: 760 },
  person: { width: 140, backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: C.line, paddingVertical: 16, alignItems: 'center', gap: 6 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.black, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 20 },
  personName: { fontWeight: '700', color: C.ink, maxWidth: 124 },
  personRole: { color: C.muted, fontSize: 12 },
  padWrap: { alignItems: 'center', gap: 10, width: 320, alignSelf: 'center' },
  padTitle: { fontSize: 20, fontWeight: '800', color: C.ink, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 12, marginVertical: 6 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: C.black },
  dotOn: { backgroundColor: C.black },
  // Error text is amber, not red: the brand keeps red for the mark and away from anything near an amount.
  error: { color: C.amber, fontWeight: '700', textAlign: 'center' },
  errorSpace: { lineHeight: 18 },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, width: 300 },
  key: { width: 93, height: 64, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  enter: { backgroundColor: C.black, borderColor: C.black },
  keyText: { fontSize: 24, fontWeight: '700', color: C.ink },
  back: { paddingVertical: 10, paddingHorizontal: 16, alignSelf: 'center' },
});
