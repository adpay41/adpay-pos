/**
 * A QR code drawn with plain Views (no canvas or SVG), so it renders the same in the browser and on
 * the Android customer display. Each row is a handful of dark runs, not one View per module.
 */
import { create } from 'qrcode';
import { useMemo } from 'react';
import { View } from 'react-native';

export function Qr({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const rows = useMemo(() => {
    const m = create(value, { errorCorrectionLevel: 'M' }).modules;
    const out: { x: number; w: number }[][] = [];
    for (let y = 0; y < m.size; y++) {
      const runs: { x: number; w: number }[] = [];
      for (let x = 0; x < m.size; x++) {
        if (!m.get(y, x)) continue; // BitMatrix.get(row, col)
        const last = runs[runs.length - 1];
        if (last && last.x + last.w === x) last.w++;
        else runs.push({ x, w: 1 });
      }
      out.push(runs);
    }
    return { n: m.size, rows: out };
  }, [value]);
  // A 4-module quiet zone on every side, as scanners expect.
  const cell = Math.max(1, Math.floor(size / (rows.n + 8)));
  const side = cell * (rows.n + 8);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: side, height: side, backgroundColor: '#fff', padding: cell * 4 }}>
      {rows.rows.map((runs, y) => (
        <View key={y} style={{ height: cell, width: cell * rows.n }}>
          {runs.map((r) => (
            <View key={r.x} style={{ position: 'absolute', left: r.x * cell, width: r.w * cell, height: cell, backgroundColor: '#000' }} />
          ))}
        </View>
      ))}
    </View>
  );
}
