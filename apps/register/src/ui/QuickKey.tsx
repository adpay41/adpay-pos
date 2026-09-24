/**
 * One quick-key tile: optional product photo, name, cash price (black, large) and card price.
 * The merchant's color is a pale fill plus a stripe from the fixed palette, which has no red or
 * green, so the brand rule "never red near a dollar amount" holds whatever the merchant picks.
 */
import { TILE_COLORS, type CatalogItem } from '@adpay/shared';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { API_URL } from '../runtime';
import { C, usd } from './theme';

export function QuickKey({ item, onPress, onLongPress }: { item: CatalogItem; onPress: (i: CatalogItem) => void; onLongPress?: (i: CatalogItem) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  const palette = item.color ? TILE_COLORS[item.color] : null;
  const showImage = !!item.image_url && !imageFailed;
  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={450}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${usd(item.cash_price_cents)}`}
      style={({ pressed }) => [s.key, palette && { backgroundColor: palette.fill }, pressed && s.pressed]}
    >
      {palette ? <View style={[s.stripe, { backgroundColor: palette.stripe }]} /> : null}
      <View style={s.top}>
        {showImage ? (
          // Photos are immutable URLs with a year-long cache header, so they keep showing offline once seen.
          <Image source={{ uri: `${API_URL}${item.image_url}` }} style={s.photo} onError={() => setImageFailed(true)} resizeMode="cover" />
        ) : null}
        <Text style={s.name} numberOfLines={showImage ? 2 : 3}>
          {item.name}
        </Text>
      </View>
      <View>
        <Text style={s.cash}>{usd(item.cash_price_cents)}</Text>
        <Text style={s.card}>card {usd(item.card_price_cents)}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  key: {
    width: 140,
    height: 112,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 10,
    paddingTop: 12,
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: C.line,
    overflow: 'hidden',
  },
  pressed: { borderColor: C.black, opacity: 0.85 },
  stripe: { position: 'absolute', top: 0, left: 0, right: 0, height: 5 },
  top: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  photo: { width: 40, height: 40, borderRadius: 6, backgroundColor: C.ground },
  name: { flex: 1, fontWeight: '600', color: C.ink, fontSize: 14 },
  cash: { color: C.black, fontWeight: '800', fontSize: 16, fontVariant: ['tabular-nums'] },
  card: { color: C.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
});
