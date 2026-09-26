/**
 * Help: the support chat (when the store has it switched on, P12b), problems and equipment tickets
 * (P24a), and the documents vault (P24b).
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Documents } from './documents';
import { Equipment } from './equipment';
import { SupportTab } from './support';
import { C } from './theme';

type Section = 'chat' | 'tickets' | 'documents';
const LABEL: Record<Section, string> = { chat: 'Chat', tickets: 'Problems & equipment', documents: 'Documents' };

export function HelpTab({ token, chat }: { token: string; chat: boolean }) {
  const [section, setSection] = useState<Section>(chat ? 'chat' : 'tickets');
  const sections: Section[] = chat ? ['chat', 'tickets', 'documents'] : ['tickets', 'documents'];
  return (
    <View style={{ flex: 1 }}>
      <View style={s.segment}>
        {sections.map((k) => (
          <Pressable key={k} onPress={() => setSection(k)} style={[s.item, section === k && s.on]}>
            <Text style={[s.text, section === k && { color: '#fff' }]}>{LABEL[k]}</Text>
          </Pressable>
        ))}
      </View>
      {section === 'chat' && chat ? (
        <SupportTab token={token} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }}>{section === 'documents' ? <Documents token={token} /> : <Equipment token={token} />}</ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  item: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  on: { backgroundColor: C.black, borderColor: C.black },
  text: { color: C.ink, fontWeight: '600' },
});
