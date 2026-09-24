# 0021: Feature flags per merchant, pack editor, support chat

- Status: Accepted
- Date: 2026-09-24
- Build plan: P12b. Bible: L52, L40 (chat part)
- Extends: CLAUDE.md "vertical packs", ADR 0012 (`/ws`)

## Decisions

### 1. Flags are code-defined with defaults; merchants store overrides only
`FEATURE_FLAGS` in `packages/shared/src/flags.ts` lists each flag with a label, where it applies
and its default. `merchants.feature_flags` stores only the overrides, and the admin panel removes
an override when it matches the default. That way, changing a default later reaches every merchant
who never touched it. The first flags are:

- `card_payments`: the Card button, the cash-only banner and partial-cash split;
- `register_item_create`: the unknown-barcode flow;
- `price_check`;
- `hold_tickets`;
- `support_chat`.

### 2. Delivered in the config snapshot
The resolved flags and `enabled_packs` ride in `CatalogSnapshot`. A change bumps the catalog
version, so registers pick it up on their next tick (≤ 15 s) or immediately via the `/ws` catalog
nudge. An older cached snapshot has no flags, which means everything is on: a register never
loses features because it is behind.

### 3. Pack editor
`PUT /admin/merchants/:id/packs` replaces the list (at least one pack). A newly enabled pack seeds
its starter categories, skipping any name that already exists. Disabling a pack removes nothing,
because the merchant's categories and items are theirs. Stub packs (liquor, restaurant, grocery)
can be enabled and add nothing, which is the spec's acceptance test.

### 4. Support chat: one conversation per merchant
`support_messages` is append-only (`forbid_mutation`). `support_reads` records how far each side
has read, which drives the admin inbox's unread counts.

- Any staff member with app access can write; it isn't limited to people who see the figures.
- A new message is NOTIFY'd on commit and pushed over `/ws` to that merchant's app users and to
  AD Pay admins, never to other merchants or registers.
- The `support_chat` flag turns it off per merchant.

"Share my screen from the register" needs the device-management vendor, which is still an open
decision (Esper or our own), so it is not built (⛔).
