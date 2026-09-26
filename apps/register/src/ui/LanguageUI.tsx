/**
 * The cashier's language picker (P18b): a small button showing the current language in its own
 * script; tap for the list. Used on "Who's working?" and in the sale screen's header.
 */
import { languageInfo } from '@adpay/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useCashierLanguage, useT } from './i18n';
import { C } from './theme';

export function LanguageButton({ dark = false }: { dark?: boolean }) {
  const { lang, choices, setLang } = useCashierLanguage();
  const t = useT();
  const [open, setOpen] = useState(false);
  if (choices.length < 2) return null;
  return (
    <View style={s.wrap}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={[s.button, dark && s.buttonDark]}
        accessibilityRole="button"
        accessibilityLabel={t('Register language: {language}', { language: languageInfo(lang).native })}
      >
        <Text style={[s.buttonText, dark && { color: '#fff' }]}>🌐 {languageInfo(lang).native}</Text>
      </Pressable>
      {open ? (
        <View style={s.menu}>
          {choices.map((code) => (
            <Pressable
              key={code}
              onPress={() => {
                setLang(code);
                setOpen(false);
              }}
              style={[s.item, code === lang && s.itemOn]}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: code === lang }}
            >
              <Text style={[s.itemText, code === lang && { color: '#fff' }]}>{languageInfo(code).native}</Text>
              <Text style={[s.itemSub, code === lang && { color: '#ddd' }]}>{languageInfo(code).name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 20 },
  button: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5 },
  buttonDark: { backgroundColor: 'transparent', borderColor: '#555' },
  buttonText: { color: C.ink, fontWeight: '600' },
  menu: { position: 'absolute', top: 34, right: 0, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 6, minWidth: 190, gap: 2 },
  item: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6 },
  itemOn: { backgroundColor: C.black },
  itemText: { fontSize: 16, fontWeight: '700', color: C.ink },
  itemSub: { fontSize: 12, color: C.muted },
});
