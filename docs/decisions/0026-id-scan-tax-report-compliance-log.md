# 0026: ID scan, sales-tax report, compliance log, tax-tables view

- Status: Accepted
- Date: 2026-09-24
- Build plan: P16b. Bible 1.4 (ID scan; compliance log export), 2.2 (sales tax report, quarterly
  filing pack), 3.4 (tax tables by jurisdiction)
- Extends: ADR 0018 (compliance tables), ADR 0025

## Decisions

### 1. ID scan returns derived facts only
`checkId(raw, minAge, today)` parses the AAMVA PDF417 payload that a 2D wedge scanner types. It
handles CR/LF variants, the first element on the header line, and US MMDDCCYY or Canadian
CCYYMMDD dates. It returns only:

- `ok`;
- `age` on the day;
- `expires`;
- `jurisdiction`;
- `flags`: unreadable, expired, under_age, implausible_dates.

The licence number, name, address and date of birth are read to compute these and are **never
returned**, so no code path can log or sync them.

`sale.age_verified` gains `method: 'id_scan'` and `id_check: { age, jurisdiction }` (additive).

**Register**: while an age check is open, the wedge lines are buffered and parsed after 250 ms of
quiet.

- A pass rings the item, or the whole batch for repeat/usual, with the check recorded.
- Under age or expired shows the reason and **disables the manual "ID checked"** for that item.
- Unreadable or implausible shows the reason and leaves the manual check available.

A header-vs-jurisdiction consistency check needs the verified AAMVA issuer (IIN) table. It is not
guessed: a wrong table would flag genuine licences.

### 2. The sales-tax report is folded from sales, like the receipts
`saleTaxGroups`, `saleSubtotal`, `saleCharges` and `refundTax` live in shared. The report covers a
range of up to a quarter:

- per month and in total: sales count, gross, taxable and non-taxable, tax by rate;
- deposits and fees, shown for the filing;
- refunds, with **the tax inside them** (computed from the refunded lines, prorated like refunds);
- net tax.

A sale voided after completion is not a sale; its refund events return the money. The CSV has a
taxable/tax column pair per rate and a row per month plus the total: the quarterly filing pack.
The accountant files from it.

### 3. Compliance log for an inspector
Every `sale.age_verified` in the range, with:

- register and cashier;
- item, restriction and minimum age;
- how it was checked: by eye, or ID scanned with the scanned age and state;
- the ticket number.

The CSV export is one button in the merchant app. Voided tickets still show their checks, because
the check happened.

### 4. Tax tables across stores
`/admin/tax` lists every location by state: the standard rate in force today, rate changes already
scheduled, classes, charges (flagging any that apply to nothing), and age overrides. A state whose
stores disagree on the rate is marked. Rules stay edited per location (ADR 0018); this view is for
spotting drift.

## Also fixed
P16a's training mode still rang repeat-last/usual batches into the real session, and showed held
tickets and refunds from it. Batches now go to the active session, held tickets follow it, and
Tickets (real refunds and voids) is hidden in training.
