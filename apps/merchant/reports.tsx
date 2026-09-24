/**
 * Tax & compliance (build plan P16b, ADR 0026): the sales-tax figures for a quarter (the filing
 * pack: by month, by rate, refunds, net) and the age-check log an inspector asks for, both
 * exportable as CSV for the accountant.
 */
import { complianceCsv, localDate, ppmToPercent, salesTaxCsv, type ComplianceEntry, type SalesTaxReport } from '@adpay/shared';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C, usd } from './theme';

/** Calendar quarter containing today (offset 0) or an earlier one. */
function quarter(offset: number): { from: string; to: string; label: string } {
  const today = localDate(new Date(), 'America/New_York');
  let y = Number(today.slice(0, 4));
  let qi = Math.floor((Number(today.slice(5, 7)) - 1) / 3) - offset;
  while (qi < 0) {
    qi += 4;
    y -= 1;
  }
  const m1 = qi * 3 + 1;
  const last = new Date(Date.UTC(y, m1 + 2, 0)).getUTCDate();
  return { from: `${y}-${String(m1).padStart(2, '0')}-01`, to: `${y}-${String(m1 + 2).padStart(2, '0')}-${last}`, label: `Q${qi + 1} ${y}` };
}

async function exportText(name: string, text: string) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    await Share.share({ title: name, message: text });
  }
}

export function TaxCompliance({ token }: { token: string }) {
  const [offset, setOffset] = useState(0);
  const q = quarter(offset);
  const [tax, setTax] = useState<SalesTaxReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setTax(null);
    api<SalesTaxReport>(`/merchant/reports/sales-tax?from=${q.from}&to=${q.to}`, token).then(
      (r) => live && setTax(r),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [q.from, q.to, token]);

  async function exportCompliance() {
    const r = await api<{ entries: ComplianceEntry[] }>(`/merchant/reports/compliance?from=${q.from}&to=${q.to}`, token);
    await exportText(`age-checks-${q.from}-to-${q.to}.csv`, complianceCsv(r.entries));
  }

  return (
    <View style={s.card}>
      <View style={s.head}>
        <Text style={s.label}>Tax & compliance · {q.label}</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {[0, 1].map((o) => (
            <Pressable key={o} onPress={() => setOffset(o)} style={[s.chip, offset === o && s.chipOn]}>
              <Text style={offset === o ? { color: '#fff' } : { color: C.ink }}>{o === 0 ? 'This quarter' : 'Last quarter'}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {tax ? (
        <>
          <View style={s.line}>
            <Text style={s.name}>Sales tax collected</Text>
            <Text style={s.money}>{usd(tax.total.tax_cents)}</Text>
          </View>
          {tax.total.by_rate.map((r) => (
            <Text key={r.rate_ppm} style={s.muted}>
              {ppmToPercent(r.rate_ppm)}% on {usd(r.taxable_cents)} → {usd(r.tax_cents)}
            </Text>
          ))}
          <Text style={s.muted}>
            Gross sales {usd(tax.total.gross_sales_cents)} · non-taxable {usd(tax.total.non_taxable_cents)} · deposits & fees {usd(tax.total.deposits_fees_cents)}
          </Text>
          <Text style={s.muted}>
            Tax refunded {usd(tax.total.refunds_tax_cents)} · net tax {usd(tax.total.net_tax_cents)}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Pressable style={s.button} onPress={() => void exportText(`sales-tax-${q.from}-to-${q.to}.csv`, salesTaxCsv(tax))}>
              <Text style={s.buttonText}>Export sales tax (CSV)</Text>
            </Pressable>
            <Pressable style={s.button} onPress={() => void exportCompliance().catch((e) => setError((e as Error).message))}>
              <Text style={s.buttonText}>Export age-check log (CSV)</Text>
            </Pressable>
          </View>
          <Text style={[s.muted, { marginTop: 6 }]}>Figures for your accountant to file from; they check the rates and any adjustments.</Text>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  muted: { color: C.muted, fontSize: 13 },
  error: { color: C.red },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  name: { color: C.ink, fontWeight: '600' },
  money: { color: C.black, fontWeight: '800', fontVariant: ['tabular-nums'] },
  button: { backgroundColor: C.black, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  buttonText: { color: '#fff', fontWeight: '700' },
});
