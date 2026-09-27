/**
 * Move from NRS (ADR 0043, docs/nrs-migration-method.md): pick the price book file, preview what
 * will be created / updated / left alone and what can't be carried over, confirm each department's
 * tax and age setting, then import. The preview is the same write rolled back.
 */
import { nrsImportReport, type NrsDepartmentChoices, type NrsImportResponse } from '@adpay/shared';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from './api';
import { C, usd } from './theme';

/** The web build reads a file from the computer (where the NRS portal runs); phones get a pointer. */
function pickFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,application/json,text/csv';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then((text) => resolve({ name: file.name, text }));
    };
    input.click();
  });
}

const AGE: { key: NrsDepartmentChoices[string]['restriction']; label: string; min_age: number | null }[] = [
  { key: null, label: 'No age check', min_age: null },
  { key: 'tobacco', label: 'Tobacco 21+', min_age: 21 },
  { key: 'vape', label: 'Vape 21+', min_age: 21 },
  { key: 'alcohol', label: 'Alcohol 21+', min_age: 21 },
];

export function NrsImport({ token, onSaved }: { token: string; onSaved: (msg: string) => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<NrsImportResponse | null>(null);
  const [done, setDone] = useState<NrsImportResponse | null>(null);
  const [choices, setChoices] = useState<NrsDepartmentChoices>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dry: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<NrsImportResponse>('/merchant/catalog/import/nrs', token, { file: file.text, dry_run: dry, skip_errors: true, departments: choices }, 'POST');
      if (dry) {
        setPreview(r);
        const next: NrsDepartmentChoices = {};
        for (const d of r.parse.departments) if (!d.exists) next[d.name] = choices[d.name] ?? { taxable: d.taxable, min_age: d.min_age, restriction: d.restriction };
        setChoices(next);
      } else {
        setDone(r);
        setPreview(null);
        onSaved(nrsImportReport(r).headline);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (name: string, patch: Partial<NrsDepartmentChoices[string]>) => setChoices({ ...choices, [name]: { ...choices[name]!, ...patch } });

  if (Platform.OS !== 'web') {
    return (
      <View style={s.card}>
        <Text style={s.h2}>Move from NRS</Text>
        <Text style={s.body}>Open the merchant app on a computer (the web version) to upload your NRS price book: the file comes from the NRS portal in a desktop browser.</Text>
      </View>
    );
  }

  const report = preview ? nrsImportReport(preview) : done ? nrsImportReport(done) : null;
  return (
    <View style={{ gap: 12 }}>
      <View style={s.card}>
        <Text style={s.h2}>Move from NRS</Text>
        <Text style={s.body}>
          Upload your NRS price book: the items file from the NRS portal (JSON, with real barcodes — best), or the portal's CSV export (its barcodes are scrambled,
          so each item gets its barcode the first time you scan it). Uploading again later updates prices; it never makes duplicates.
        </Text>
        <Pressable
          style={s.buttonGhost}
          disabled={busy}
          onPress={() =>
            void pickFile().then((f) => {
              if (!f) return;
              setFile(f);
              setPreview(null);
              setDone(null);
              setChoices({});
            })
          }
        >
          <Text style={s.buttonGhostText}>{file ? `File: ${file.name} — choose another` : 'Choose the NRS file'}</Text>
        </Pressable>
        {file && !preview ? (
          <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void run(true)}>
            <Text style={s.buttonText}>{busy ? 'Reading…' : 'Preview'}</Text>
          </Pressable>
        ) : null}
        {error ? <Text style={s.warn}>{error}</Text> : null}
      </View>

      {report ? (
        <View style={s.card}>
          <Text style={s.label}>{done ? 'Imported' : 'Preview — nothing saved yet'}</Text>
          <Text style={[s.body, { fontWeight: '700' }]}>{report.headline}</Text>
          {report.lines.map((l) => (
            <Text key={l} style={s.body}>
              {l}
            </Text>
          ))}
          {report.unmapped.length ? (
            <>
              <Text style={s.label}>Couldn't carry over exactly</Text>
              {report.unmapped.map((l) => (
                <Text key={l} style={s.warn}>
                  {l}
                </Text>
              ))}
            </>
          ) : null}
        </View>
      ) : null}

      {preview ? (
        <View style={s.card}>
          <Text style={s.label}>Departments → categories: check tax and age</Text>
          {preview.parse.departments.map((d) => {
            const c = choices[d.name];
            return (
              <View key={d.name} style={s.dept}>
                <Text style={[s.body, { fontWeight: '700' }]}>
                  {d.name} <Text style={s.muted}>· {d.items} items{d.exists ? ' · already in your catalog, settings kept' : ''}</Text>
                </Text>
                {c ? (
                  <View style={s.chips}>
                    {([true, false] as const).map((taxable) => (
                      <Pressable key={String(taxable)} onPress={() => set(d.name, { taxable })} style={[s.chip, c.taxable === taxable && s.chipOn]}>
                        <Text style={[s.chipText, c.taxable === taxable && s.chipTextOn]}>{taxable ? 'Taxed' : 'No tax'}</Text>
                      </Pressable>
                    ))}
                    {AGE.map((a) => (
                      <Pressable key={a.label} onPress={() => set(d.name, { restriction: a.key, min_age: a.min_age })} style={[s.chip, c.restriction === a.key && s.chipOn]}>
                        <Text style={[s.chipText, c.restriction === a.key && s.chipTextOn]}>{a.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {preview?.parse.flags.length ? (
        <View style={s.card}>
          <Text style={s.label}>Items to look at after importing</Text>
          {preview.parse.flags.map((f) => (
            <Text key={f.key} style={s.muted}>
              <Text style={s.body}>{f.count}</Text> · {f.label} — e.g. {f.examples.slice(0, 4).join(', ')}
            </Text>
          ))}
        </View>
      ) : null}

      {preview?.result ? (
        <View style={s.card}>
          <Text style={s.label}>First changes</Text>
          {preview.result.sample.slice(0, 12).map((x, i) => (
            <Text key={i} style={s.muted}>
              {x.action === 'create' ? 'New' : x.action === 'update' ? 'Update' : 'Same'} · {x.name} · {x.from_cents !== null && x.action === 'update' ? `${usd(x.from_cents)} → ` : ''}
              {usd(x.to_cents)}
            </Text>
          ))}
          <Pressable style={[s.button, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void run(false)}>
            <Text style={s.buttonText}>{busy ? 'Importing…' : `Import ${preview.result.created + preview.result.updated + preview.result.unchanged} items`}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 14, gap: 8 },
  h2: { fontSize: 17, fontWeight: '800', color: C.ink },
  label: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  body: { color: C.ink },
  muted: { color: C.muted },
  warn: { color: '#8a5300' },
  dept: { gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#cfcfcf', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: '#fff' },
  chipOn: { backgroundColor: C.black, borderColor: C.black },
  chipText: { color: C.ink, fontSize: 13 },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  button: { backgroundColor: C.black, borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  buttonGhost: { borderWidth: 1, borderColor: C.black, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonGhostText: { color: C.ink, fontWeight: '700' },
});
