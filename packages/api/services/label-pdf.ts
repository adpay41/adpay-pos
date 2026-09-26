/**
 * Label PDF (P21, ADR 0033): shelf tags and price labels, written directly as PDF 1.4.
 *
 * No PDF library: text is the built-in Helvetica / Helvetica-Bold (every PDF reader has them, so
 * nothing is embedded), barcodes are filled rectangles from the shared module strings, and the page
 * is the label stock (an Avery 5160 US Letter sheet, or one thermal label per page, which is what
 * label-printer drivers expect). Text is measured with the standard Helvetica widths so names are cut
 * to fit, never overflow a tag.
 */
import { LABEL_SIZES, type LabelSize, type TagContent } from '@adpay/shared';

// Standard Helvetica widths (1/1000 em) for ASCII 32–126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Characters outside ASCII that WinAnsi can print; anything else becomes '?'. */
const WIN_ANSI: Record<string, number> = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, '·': 0xb7, '¢': 0xa2, '°': 0xb0, '½': 0xbd, '¼': 0xbc, '×': 0xd7, '″': 0x22 };

function winAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) out += ch;
    else if (WIN_ANSI[ch] !== undefined) out += String.fromCharCode(WIN_ANSI[ch]);
    else if (c >= 0xa0 && c <= 0xff) out += ch; // Latin-1 letters (é, ñ) are the same in WinAnsi
    else out += '?';
  }
  return out;
}

function width(text: string, size: number, bold: boolean): number {
  const w = bold ? W_BOLD : W_REG;
  let units = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    units += c >= 32 && c <= 126 ? w[c - 32]! : 556;
  }
  return (units * size) / 1000;
}

/** Cut to fit, with an ellipsis. */
function fit(text: string, size: number, bold: boolean, max: number): string {
  if (width(text, size, bold) <= max) return text;
  let t = text;
  while (t.length > 1 && width(`${t}\x85`, size, bold) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}\x85`;
}

/** Up to two lines, word-wrapped, the second cut to fit. */
function twoLines(text: string, size: number, bold: boolean, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  let first = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = first ? `${first} ${words[i]}` : words[i]!;
    if (width(next, size, bold) > max) break;
    first = next;
  }
  if (!first) return [fit(text, size, bold, max)];
  const rest = words.slice(i).join(' ');
  return rest ? [first, fit(rest, size, bold, max)] : [first];
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function drawTag(ops: string[], tag: TagContent, x: number, yTop: number, w: number, h: number): void {
  const k = h / 72; // everything scales with the label height
  const pad = 5 * k;
  const inner = w - 2 * pad;
  let y = yTop - pad;
  const text = (s: string, size: number, bold: boolean, tx: number) => {
    y -= size;
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(tx)} ${n(y)} Td (${esc(s)}) Tj ET`);
  };
  const titleSize = 7.5 * k;
  for (const line of twoLines(winAnsi(tag.title), titleSize, true, inner)) {
    text(line, titleSize, true, x + pad);
    y -= 1 * k;
  }
  if (tag.category) text(fit(winAnsi(tag.category), 5.5 * k, false, inner), 5.5 * k, false, x + pad);

  // Both prices, cash first and biggest (NJ/NY posted pricing: the card price is on the tag too).
  const cashSize = 15 * k;
  y -= 2 * k;
  const priceBase = y - cashSize;
  ops.push(`BT /F2 ${n(cashSize)} Tf ${n(x + pad)} ${n(priceBase)} Td (${esc(tag.cash)}) Tj ET`);
  const cashW = width(tag.cash, cashSize, true);
  ops.push(`BT /F1 ${n(5.5 * k)} Tf ${n(x + pad + cashW + 2 * k)} ${n(priceBase)} Td (cash) Tj ET`);
  if (tag.card) {
    const cardSize = 9 * k;
    const label = `card ${tag.card}`;
    const cx = x + w - pad - width(label, cardSize, true);
    ops.push(`BT /F2 ${n(cardSize)} Tf ${n(Math.max(cx, x + pad + cashW + 20 * k))} ${n(priceBase)} Td (${esc(label)}) Tj ET`);
  }
  y = priceBase - 2 * k;
  if (tag.note) text(fit(winAnsi(tag.note), 5 * k, false, inner), 5 * k, false, x + pad);

  if (tag.barcode) {
    const barH = Math.max(8 * k, y - (yTop - h) - pad - 1);
    const m = tag.barcode.modules;
    const mw = Math.min(1.1 * k, inner / (m.length + 10));
    const bx = x + (w - m.length * mw) / 2;
    const by = yTop - h + pad;
    let run = 0;
    for (let i = 0; i <= m.length; i++) {
      if (m[i] === '1') run++;
      else if (run) {
        ops.push(`${n(bx + (i - run) * mw)} ${n(by)} ${n(run * mw)} ${n(Math.min(barH, 22 * k))} re`);
        run = 0;
      }
    }
    ops.push('f');
  }
}

/** One PDF for these tags on this stock: as many pages as it takes. */
export function labelsPdf(tags: readonly TagContent[], size: LabelSize): Buffer {
  const L = LABEL_SIZES[size];
  const perPage = L.cols * L.rows;
  const pages: string[] = [];
  for (let p = 0; p < Math.max(1, Math.ceil(tags.length / perPage)); p++) {
    const ops: string[] = ['0 g'];
    tags.slice(p * perPage, (p + 1) * perPage).forEach((tag, i) => {
      const col = i % L.cols;
      const row = Math.floor(i / L.cols);
      const x = L.margin.left + col * (L.cell.w + L.gap.x);
      const yTop = L.page.h - L.margin.top - row * (L.cell.h + L.gap.y);
      drawTag(ops, tag, x, yTop, L.cell.w, L.cell.h);
    });
    pages.push(ops.join('\n'));
  }

  // Objects: 1 catalog, 2 pages, 3–4 fonts, then a page + content per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((content, i) => {
    const pageObj = 5 + i * 2;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${L.page.w} ${L.page.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
    objects[pageObj + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
