/**
 * Help: the support chat (when the store has it switched on, P12b) and, always, problems and
 * equipment tickets (P24a).
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Equipment } from './equipment';
import { SupportTab } from './support';
import { C } from './theme';

export function HelpTab({ token, chat }: { token: string; chat: boolean }) {
  const [section, setSection] = useState<'chat' | 'tickets'>(chat ? 'chat' : 'tickets');
  return (
    <View style={{ flex: 1 }}>
      {chat ? (
        <View style={s.segment}>
          {(['chat', 'tickets'] as const).map((k) => (
            <Pressable key={k} onPress={() => setSection(k)} style={[s.item, section === k && s.on]}>
              <Text style={[s.text, section === k && { color: '#fff' }]}>{k === 'chat' ? 'Chat' : 'Problems & equipment'}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {section === 'chat' && chat ? (
        <SupportTab token={token} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Equipment token={token} />
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  segment: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  item: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  on: { backgroundColor: C.black, borderColor: C.black },
  text: { color: C.ink, fontWeight: '600' },
});
