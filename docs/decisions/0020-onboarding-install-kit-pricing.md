# 0020: Onboarding wizard, install kits with setup QR, pricing plans with history

- Status: Accepted
- Date: 2026-09-24
- Build plan: P12a. Bible: L42 (minus KYB and hardware ordering), L43, L51
- Extends: ADR 0011 (memberships), ADR 0018 (compliance templates)

## Decisions

### 1. The wizard is one API call, one transaction
`POST /admin/onboarding` takes everything the six-step admin wizard collects and creates it all
inside a single transaction:

- the org, new or existing;
- the merchant, with its packs' starter categories as the catalog template (tobacco and lottery
  carry their restriction, so the state's age rule applies);
- the owner (membership plus app access by phone);
- the location, with a draft state compliance template if one is chosen: the deposit goes on the
  drinks category, and the vape tax on any vape-restricted category;
- N registers;
- the first pricing plan;
- the onboarding record.

Any failure rolls the whole thing back, so a store without an owner, or registers without a
location, cannot exist. `createStaff` was split so its body (`insertStaff`) runs inside the
caller's transaction.

### 2. Pipeline record per merchant
`merchant_onboarding` tracks three things:

- `status`: `setting_up`, then `ready_to_install`, then `live`;
- `kyb_status`;
- the install date and a hardware note. Hardware is ordered outside the system; the note holds
  what was ordered and the tracking number.

Every merchant gets a row, including ones created the old way; existing ones were backfilled as
`live`. **Pairing the first register sets `live`** automatically. KYB runs through the processor
and stays "not started" until the AD Pay LLC Finix account exists (⛔, ADR 0006).

### 3. Install kit = fresh 14-day setup codes as QR
`POST /admin/merchants/:id/install-kit` issues a new code for every unpaired register. Codes
last 14 days (instead of 24 h) so the kit can be printed before the visit, and any earlier unused
codes stop working. Paired registers are left alone. The admin page prints one card per register:

- a QR that holds **only the setup code**;
- the code in text under it;
- four install steps;
- the store Wi-Fi and the support number.

The register's pairing field is focused on open, so a 2D scanner reading the QR types the code
and presses Enter. The Wi-Fi details are typed into the page for printing only and are never sent
or stored. The QR is drawn in the browser with the `qrcode` package.

### 4. Pricing plans are append-only
`merchant_pricing_plans` rows are never updated or deleted (`forbid_mutation` trigger), so the
history is the table. There are three models, each with a monthly subscription and a
per-extra-register fee:

- dual pricing (card markup ppm);
- interchange-plus (markup ppm plus per-transaction cents);
- flat (rate ppm plus per-transaction cents).

The plan in force is the latest `effective_from` on or before the store's date; ties go to the
newest row (`planOn`). A dual-pricing plan can also set every location's card markup, but only
once it has started, because that moves card prices on the registers.

## Not here
- KYB submission (Finix ⛔).
- Hardware ordering (external).
- Residual/margin reporting from plans (P13).
- Feature flags, the pack editor and support chat: P12b.
