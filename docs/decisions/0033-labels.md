# 0033: Shelf tags, price labels, label templates

- Status: Accepted
- Date: 2026-09-26
- Build plan: P21. Bible 1.6 (label printing: shelf tags with cash and card price, barcode labels for
  open-price items), 2.3 (shelf label print queue), 3.4 (receipt/label template editor)
- Extends: ADR 0016 (receipt templates), ADR 0013 (barcodes), ADR 0032 (price history)

## Decisions

### 1. Labels are PDFs we write ourselves
`labelsPdf` writes PDF 1.4 directly, with no library or dependency:
- **text** in the built-in Helvetica / Helvetica-Bold (WinAnsi, so nothing is embedded and every
  reader has them), measured with the standard widths so a long name is wrapped and cut, never
  overflowing;
- **barcodes** as filled rectangles drawn from shared module strings.

There are two stocks:
- **Avery 5160**: 30 per US Letter sheet, printable **on any office printer today**.
- **Thermal 2.25″ × 1.25″**: one label per page, which is what label-printer drivers take.

### 2. Barcodes are shared and tested
`packages/shared/src/labels.ts` encodes UPC-A, EAN-13 and Code 128 (set B). Tests check:
- the check digits of well-known codes;
- guard patterns, and odd/even parity per side;
- all 107 Code 128 patterns (widths sum to 11, or 13 for stop; all distinct);
- start and stop symbols.

An item without a barcode of its own gets an **in-store UPC-A** (number system 4, the next free one
for the merchant) when its tag is printed. It is added to the item's barcodes and the catalog version
is bumped, so the tag scans at the register.

### 3. Tags show both prices, as the register charges them
The tag carries the cash price (biggest), the card price, and a line such as "Cash price · Card
price". Prices resolve for the chosen store: its dual rate, or the item's fixed card price. A template
can drop the card price, and the editor says why it shouldn't (NJ/NY posted pricing).

### 4. The reprint queue is prices that moved since the tag
Printing records each tag's prices in `shelf_tag_prints`. The queue is every active, fixed-price item
whose current price differs from its last printed tag, plus items whose price changed in the last 14
days and never had a tag. "Print N tags" clears it.

### 5. Price labels for the deli ring at the printed price
For an open-price item with a PLU, a price label is a price-embedded UPC-A: `2` + PLU(5) +
price(5, up to $999.99) + check. The shared scanner decoder (`lookupBarcode`) recognises it, including
with the leading 0 an EAN-13 reader adds, and finds the item by PLU. The register rings it **at the
printed price** without asking, with the card price derived at the store's rate.

### 6. Templates
Merchants keep named label templates (size, card price, barcode, category, small print) next to the
built-in "Shelf tag", in the merchant app → Items → Tags. The receipt template (header, logo, policy,
footer, QR, languages) has been edited per location in the merchant app and admin since P8.

## Built to the boundary
- **A direct label-printer connection** isn't built. There's no printer SDK or network printing
  (Zebra/Dymo/Brother), because we can't verify output without the hardware (P-HW).
- **Scanning printed barcodes with a real scanner** is part of P-HW. The encodings are tested but
  not yet scanned.
- The thermal PDF is sized for 2.25″ × 1.25″ stock, so a label printer prints it through its driver
  today; the Avery sheet works on any printer.
