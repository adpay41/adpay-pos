/**
 * Staff from the phone (build plan P3, Bible 2.5 / L36): who works here, their role, their register
 * PIN, and what managers and cashiers may do. Changes reach the registers on their next sync tick.
 *
 * People without `staff.manage` see only "My register PIN". PINs are typed once and sent to the
 * API, which hashes them; nothing shows or returns a PIN afterwards.
 */
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLES,
  permissionsFor,
  pinProblem,
  type Permission,
  type PermissionOverrides,
  type Role,
  type StaffMember,
} from '@adpay/shared';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api } from './api';
import { C } from './theme';

export interface Me {
  user_id: string;
  role: Role;
  permissions: Permission[];
}

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier' };
const PUSHED = 'Registers update within 15 seconds.';

export function StaffTab({ token, me }: { token: string; me: Me }) {
  const manage = me.permissions.includes('staff.manage');
  const [data, setData] = useState<{ staff: StaffMember[]; overrides: PermissionOverrides } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const [section, setSection] = useState<'people' | 'permissions'>('people');

  const load = useCallback(async () => {
    try {
      setData(await api('/merchant/staff', token));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = (msg: string) => {
    setNotice(`${msg} ${PUSHED}`);
    setTimeout(() => setNotice(null), 5000);
    setEditing(null);
    void load();
  };

  if (!manage) {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <Text style={s.h2}>My register PIN</Text>
        <Text style={s.muted}>You sign in at the register by tapping your name and typing this PIN.</Text>
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
        <PinSetter token={token} userId={me.user_id} label="Set my PIN" onSaved={saved} />
      </ScrollView>
    );
  }
  if (!data) return error ? <Text style={[s.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} />;

  if (editing) {
    return (
      <StaffEditor
        token={token}
        me={me}
        member={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={saved}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <View style={s.segment}>
        {(['people', 'permissions'] as const).map((k) => (
          <Pressable key={k} onPress={() => setSection(k)} style={[s.segmentItem, section === k && s.segmentActive]}>
            <Text style={[s.segmentText, section === k && { color: '#fff' }]}>{k === 'people' ? 'People' : 'Permissions'}</Text>
          </Pressable>
        ))}
      </View>
      {notice ? <Text style={s.notice}>{notice}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {section === 'people' ? (
        <>
          <Pressable style={s.button} onPress={() => setEditing('new')}>
            <Text style={s.buttonText}>+ Add a person</Text>
          </Pressable>
          <View style={s.card}>
            {data.staff.map((m) => (
              <Pressable key={m.user_id} style={[s.line, m.disabled && { opacity: 0.5 }]} onPress={() => setEditing(m)}>
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{m.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.lineName}>
                    {m.name}
                    {m.user_id === me.user_id ? ' (you)' : ''}
                  </Text>
                  <Text style={s.mutedSmall}>
                    {ROLE_LABEL[m.role]}
                    {m.disabled ? ' · removed' : ''}
                    {m.app_access ? ' · app access' : ''}
                  </Text>
                </View>
                <Text style={m.has_pin ? s.pinOk : s.pinMissing}>{m.has_pin ? 'PIN set' : 'No PIN'}</Text>
              </Pressable>
            ))}
          </View>
          {data.staff.every((m) => !m.has_pin) ? (
            <Text style={s.muted}>Nobody has a register PIN yet, so the register runs without sign-in and sales aren’t credited to anyone. Set a PIN for each person.</Text>
          ) : null}
        </>
      ) : (
        <Permissions token={token} overrides={data.overrides} onSaved={saved} />
      )}
    </ScrollView>
  );
}

function StaffEditor({
  token,
  me,
  member,
  onClose,
  onSaved,
}: {
  token: string;
  me: Me;
  member: StaffMember | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(member?.name ?? '');
  const [role, setRole] = useState<Role>(member?.role ?? 'cashier');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only owners hand out (or take away) the owner role.
  const roles = ROLES.filter((r) => r !== 'owner' || me.role === 'owner');

  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveNew() {
    if (pin && pinProblem(pin)) return setError(pinProblem(pin));
    await run(
      () => api('/merchant/staff', token, { name: name.trim(), role, phone: phone.trim() || null, pin: pin || null }),
      `${name.trim()} added${pin ? ' with a PIN' : ''}.`,
    );
  }

  async function saveEdit() {
    if (!member) return;
    const patch: Record<string, unknown> = {};
    if (name.trim() && name.trim() !== member.name) patch.name = name.trim();
    if (role !== member.role) patch.role = role;
    if (Object.keys(patch).length === 0) return onClose();
    await run(() => api(`/merchant/staff/${member.user_id}`, token, patch, 'PATCH'), `${name.trim()} saved.`);
  }

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <View style={s.rowBetween}>
        <Pressable onPress={onClose}>
          <Text style={s.link}>‹ Staff</Text>
        </Pressable>
        <Text style={s.h2}>{member ? member.name : 'Add a person'}</Text>
        <View style={{ width: 50 }} />
      </View>

      <Text style={s.label}>Name</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Maria Santos" maxLength={80} />

      <Text style={s.label}>Role</Text>
      <View style={s.row}>
        {roles.map((r) => (
          <Pressable key={r} onPress={() => setRole(r)} style={[s.chip, role === r && s.chipOn]}>
            <Text style={[s.chipText, role === r && { color: '#fff' }]}>{ROLE_LABEL[r]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.mutedSmall}>
        {role === 'owner' ? 'Everything, including staff.' : `Can: ${permissionsFor(role).map((p) => PERMISSIONS[p].label.toLowerCase()).join(', ')} (adjust under Permissions).`}
      </Text>

      {!member ? (
        <>
          <Text style={s.label}>Mobile number (optional)</Text>
          <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Only if they’ll use this app" keyboardType="phone-pad" />
          <Text style={s.label}>Register PIN (4–6 digits)</Text>
          <TextInput style={s.input} value={pin} onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))} placeholder="They can set it later" keyboardType="number-pad" secureTextEntry />
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Pressable style={[s.button, (busy || !name.trim()) && { opacity: 0.5 }]} disabled={busy || !name.trim()} onPress={() => void saveNew()}>
            <Text style={s.buttonText}>{busy ? 'Saving…' : 'Add'}</Text>
          </Pressable>
        </>
      ) : (
        <>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void saveEdit()}>
            <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save'}</Text>
          </Pressable>
          <View style={s.card}>
            <Text style={s.lineName}>Register PIN</Text>
            <Text style={s.mutedSmall}>{member.has_pin ? `Set ${member.pin_set_at ? new Date(member.pin_set_at).toLocaleDateString() : ''}. Setting a new one replaces it.` : 'Not set yet — they can’t sign in at the register.'}</Text>
            <PinSetter token={token} userId={member.user_id} label={member.has_pin ? 'Change PIN' : 'Set PIN'} onSaved={onSaved} />
          </View>
          {member.user_id !== me.user_id ? (
            <Pressable
              style={s.ghost}
              disabled={busy}
              onPress={() =>
                void run(
                  () => api(`/merchant/staff/${member.user_id}`, token, { disabled: !member.disabled }, 'PATCH'),
                  member.disabled ? `${member.name} can work here again.` : `${member.name} removed from the registers.`,
                )
              }
            >
              <Text style={s.ghostText}>{member.disabled ? 'Restore access' : 'Remove from staff'}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function PinSetter({ token, userId, label, onSaved }: { token: string; userId: string; label: string; onSaved: (msg: string) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    const problem = pinProblem(pin);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api(`/merchant/staff/${userId}/pin`, token, { pin }, 'PUT');
      setPin('');
      onSaved('PIN saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <View style={s.row}>
        <TextInput
          style={[s.input, { flex: 1, letterSpacing: 6 }]}
          value={pin}
          onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
          placeholder="4–6 digits"
          keyboardType="number-pad"
          secureTextEntry
          accessibilityLabel="New PIN"
        />
        <Pressable style={[s.small, (busy || pin.length < 4) && { opacity: 0.5 }]} disabled={busy || pin.length < 4} onPress={() => void save()}>
          <Text style={s.smallText}>{label}</Text>
        </Pressable>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

function Permissions({ token, overrides, onSaved }: { token: string; overrides: PermissionOverrides; onSaved: (msg: string) => void }) {
  const [o, setO] = useState<PermissionOverrides>(overrides);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const has = (role: 'manager' | 'cashier', p: Permission) => permissionsFor(role, o).includes(p);
  const toggle = (role: 'manager' | 'cashier', p: Permission, v: boolean) =>
    setO((prev) => {
      const next = { ...(prev[role] ?? {}) };
      // Store only differences from the default, so defaults can improve later for everyone.
      if (permissionsFor(role).includes(p) === v) delete next[p];
      else next[p] = v;
      return { ...prev, [role]: next };
    });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/merchant/permissions', token, o, 'PUT');
      onSaved('Permissions saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Text style={s.muted}>Owners can do everything. When a cashier needs something they can’t do, a manager or owner approves it at the register with their PIN.</Text>
      <View style={s.card}>
        <View style={[s.line, { borderBottomWidth: 2 }]}>
          <Text style={[s.label, { flex: 1 }]}>Action</Text>
          <Text style={[s.label, s.col]}>Manager</Text>
          <Text style={[s.label, s.col]}>Cashier</Text>
        </View>
        {PERMISSION_KEYS.map((p) => (
          <View key={p} style={s.line}>
            <Text style={[s.lineName, { flex: 1 }]}>{PERMISSIONS[p].label}</Text>
            {(['manager', 'cashier'] as const).map((role) => (
              <View key={role} style={s.col}>
                <Switch value={has(role, p)} onValueChange={(v) => toggle(role, p, v)} accessibilityLabel={`${role}: ${PERMISSIONS[p].label}`} />
              </View>
            ))}
          </View>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void save()}>
        <Text style={s.buttonText}>{busy ? 'Saving…' : 'Save permissions'}</Text>
      </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' },
  h2: { fontSize: 18, fontWeight: '700', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 8, padding: 12, fontSize: 16 },
  button: { backgroundColor: C.red, borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ghost: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 8, padding: 12, alignItems: 'center' },
  ghostText: { color: C.ink, fontWeight: '600' },
  small: { borderWidth: 1, borderColor: C.black, backgroundColor: C.black, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, justifyContent: 'center' },
  smallText: { color: '#fff', fontWeight: '700' },
  error: { color: C.red },
  notice: { backgroundColor: '#fff', borderLeftWidth: 4, borderLeftColor: C.black, padding: 10, borderRadius: 6, color: C.ink },
  muted: { color: C.muted },
  mutedSmall: { color: C.muted, fontSize: 12 },
  link: { color: C.ink, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 10 },
  lineName: { color: C.ink, fontWeight: '600', flexShrink: 1 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  segment: { flexDirection: 'row', backgroundColor: '#e9e9e9', borderRadius: 8, padding: 3 },
  segmentItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  segmentActive: { backgroundColor: C.black },
  segmentText: { fontWeight: '600', color: C.ink, fontSize: 13 },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontWeight: '600' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.black, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800' },
  pinOk: { color: C.ink, fontSize: 12, fontWeight: '600' },
  pinMissing: { color: C.muted, fontSize: 12, fontStyle: 'italic' },
  col: { width: 72, alignItems: 'center', textAlign: 'center' },
});
