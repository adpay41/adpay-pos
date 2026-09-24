# AD Pay POS — Feature Bible

Everything the three platforms should do, from launch through the version that makes every other
POS look like a cash register. Written for the dispatch pipeline: each feature has a one-line
"what" and a "why," a **tier**, and where relevant the statement evidence behind it.

**Tiers**
- **L** — Launch. Must exist before store #1 goes live.
- **N** — Next. First 90 days after launch. What turns a trial into a keeper.
- **M** — Moat. The stuff nobody else has. Build one at a time, each one a reason a merchant tells another merchant.

**What the statements told us (4 stores, 8 months of data)**
- Average ticket **$12.85–$18.18**. Every second at the register is worth money: 45–60 seconds per sale is the industry norm; we target **under 20**.
- **27 to 170 card transactions a day** per store; cash is roughly another 40–60% on top. Cash handling is half the job.
- **Debit is 40–77% of card volume.** Regulated debit costs ~$0.22 flat. Steering to debit and to pay-by-bank is real money.
- **Amex is 4–15%.** Bodega customers carry premium cards; interchange on those is 2.3%+.
- **Weekends and the 14th/21st spike** (Maa Dolo did $4.5k on a Saturday vs $1.2k on a Tuesday). Staffing, cash pickups and ordering should know that.
- Fees are **2.7%–3.8%** of card sales. One store pays NRS $252/mo of pure markup. Merchants don't know this because statements are unreadable. **We make fees readable — that's a feature.**
- Every one of these stores is owner-operated with high-turnover staff. **Nothing can require training.**

---

## Part 1 — The Register

### 1.1 Speed of checkout (the whole game at a $13 ticket)
- **Scan-first, zero-tap sale** — scan items, hit Cash or the customer taps; no "done" button, no confirmation. *L*
- **Quick-key grid** with per-store layout, colors, images, favorites; drag-to-arrange from the merchant app. *L / N*
- **Quantity intelligence** — tap the same item twice = qty 2; long-press for a keypad; scan a case barcode = pack qty. *L*
- **Item search** by name, UPC, PLU, first letters; fuzzy ("coke zro"). *L*
- **Unknown barcode flow** — scan an item we don't know → one screen: name, price, category, done; it's in the catalog forever and syncs to all registers. Optional UPC database lookup fills name/size automatically. *L (manual) / N (lookup)*
- **Open-price items** (deli by weight, "misc grocery") with a one-tap keypad. *L*
- **Hold / recall tickets** — customer forgot wallet; park it, serve the next, recall by tap. *L*
- **Split tender** — cash + card, two cards, with correct dual pricing per portion. *L*
- **Repeat-last-sale** — same guy, same coffee and pack every morning. *N*
- **Cashier presets** — "the usual" buttons per cashier (their regulars). *N*
- **Predictive next item** — after "large coffee" the grid surfaces "bagel"/"cigarettes" for this store's real basket pairs. *M*

### 1.2 Cash (half the sales, all of the shrink)
- **Cash tender keypad** with quick-cash buttons tuned to the ticket ($13.50 → $15, $20). *L*
- **Change display on the customer screen** in big green. *L*
- **Drawer discipline** — drawer opens only on tender or PIN; every open is an event with cashier id. *L*
- **Cash drops / safe drops / paid-outs / paid-ins** (vendor paid in cash from the drawer — huge in bodegas), all logged. *L*
- **Blind cash count at shift end**; over/short by cashier; trend over time. *L*
- **Cash-in-drawer alert** — "drawer over $600, drop now" on the customer-idle screen only the cashier sees. *N*
- **Counterfeit note flag** — mark a bill rejected; log it. *N*
- **Coin/bill denominations in the count**, with a photo of the count sheet. *N*

### 1.3 Card and other tenders
- **Terminal tender** — amount pushed to the PAX; approved/declined back; no manual entry, ever. *L*
- **Dual pricing correct on every path** — cash price, card price, split, refund, void; both totals on receipt. *L*
- **Debit preference prompt** on the terminal for debit-heavy stores (state-legal steering). *N*
- **Pay-by-bank QR** on the customer screen (Aeropay-style, ~$0.50 flat): the store pays 3¢ instead of 3%. Show "Pay by bank, save 3%" on the card price. *M*
- **Store credit / "khata" tab** — trusted regulars run a tab, pay weekly; balance on the customer screen, reminder by text. The bodega feature every immigrant neighborhood runs on paper today. *M*
- **Gift cards** (physical + digital) with balance check. *N*
- **Manual card entry** for phone orders, PIN-gated, higher price mode. *N*
- **Tips** (for the deli counter) — on the customer screen, optional per store, pooled or per cashier. *N*
- **Bill pay / phone top-up / money transfer** as a tender-side service (BOSS Revolution / Ria-class partners) — traffic driver, commission line. *M*

### 1.4 Restricted items and compliance
- **Age verification prompt** on tobacco / vape / alcohol / lottery by category; cashier confirms; logged with cashier id, time, item. *L*
- **ID scan** — 2D barcode on driver's licenses via the same scanner; computes age, flags expired/fake pattern, logs the check (not the ID number). *N*
- **Tobacco scan-data reporting** (Altria, RJR, ITG) — weekly automatic submission; stores get paid buydowns monthly. NRS's single most-cited feature. *N*
- **Manufacturer promo sync** — multipack/cents-off deals pulled from the programs and applied at the register automatically. *N*
- **Lottery module** — scratch-off activation by pack, per-game tracking, instant-ticket inventory, daily lottery reconciliation against the state terminal, payouts logged against the drawer. *N*
- **State tax tables** — cigarette, vape, sugar (Philly), bottle deposits (NY 5¢), bag fees (NJ). Per location, with effective dates. *L (basic) / N (full)*
- **Compliance log export** — age checks, lottery, tobacco, for an inspector, one button. *N*

### 1.5 Customer screen (the second screen is a product, not a mirror)
- **Live cart with both prices**, tax, totals; large type, readable from 3 ft. *L*
- **States:** idle → cart → "tap on the card machine" → approved/declined → thank you + change. *L*
- **Digital receipt** — QR the customer scans, or text-to-phone (no email walls). *N*
- **Loyalty by phone number** — customer types their number on the customer screen; points/visits; "5th coffee free." *N*
- **Language toggle** — Spanish, Gujarati, Hindi, Bengali, Arabic, Korean, Chinese, Haitian Creole. Cashier and customer sides independently. *N*
- **Deals of the day / store promotions** in idle state, set by the merchant from their phone. *N*
- **Lottery results and jackpot** in idle state (traffic magnet). *N*
- **Charity round-up** ("round up 42¢ for the local mosque/church/school") — store chooses the cause. *M*
- **Ad network** — CPG promotions the store gets paid for (NRS Digital Media model); store opts in; revenue share on the statement. *M*
- **Accessibility** — high-contrast, large-type mode; screen reader labels. *N*

### 1.6 Receipts and printing
- **80mm receipt** with store logo, both prices, dual-pricing disclosure, itemized tax, return policy, QR for digital copy. *L*
- **Receipt language** follows the customer screen language. *N*
- **Reprint any ticket** from the register; **email/text a receipt** later from the merchant app. *L / N*
- **Kitchen/deli ticket** to a second printer for made-to-order (sandwiches). *N*
- **Label printing** — shelf tags with cash and card price (dual-pricing compliance), barcode labels for open-price items. *N*

### 1.7 Offline, resilience, and the "never lose a sale" rules
- **72h offline** on cash, full catalog, receipts, drawer. *L*
- **Store-and-forward status** for cards when the terminal is offline (if processor supports); otherwise "cash only" banner and one-tap retry. *L*
- **Power-loss safe** — tender + completion written together before the drawer opens. *L*
- **UPS aware** — on battery → banner, don't start long jobs, flush the queue. *N*
- **Self-healing** — app crash → auto-restart into the same ticket. *L*
- **Printer/scanner/terminal health** on the sync pill; one-tap tests. *L*

### 1.8 Staff
- **Cashier PIN sign-in**, roles (cashier / manager / owner), permissions per action (void, refund, discount, open drawer, price override). *L*
- **Time clock** — clock in/out at the register; hours to the merchant app; overtime flags. *N*
- **Shift handover** — cash count out/in, with photo. *N*
- **Manager override by phone** — cashier requests a void; owner approves from the merchant app in 5 seconds without walking over. *M*
- **Training mode** — a sandbox ticket that prints "TRAINING" and posts nothing. *N*

### 1.9 Inventory at the register (light, fast, useful)
- **Receive delivery by scan** — vendor drops 12 cases; scan each, quantities update; DSD invoice matched later. *N*
- **Low-stock badge** on the tile; "3 left." *N*
- **Case-break** — carton to pack, pack to single; inventory converts. *L (pricing) / N (inventory)*
- **Expiry dates** on perishables; "sell by" alerts on the idle screen for the cashier. *N*
- **Waste / spoilage / theft write-offs** with reason, PIN. *N*
- **Price check** — scan without ringing; shows cash/card/margin (margin only with PIN). *L*

### 1.10 The cashier's cockpit (things nobody puts on a register)
- **Hourly target ribbon** — "you're at $412, yesterday same hour $380." *N*
- **Camera panel** — store cameras (RTSP/ONVIF) as a tile; one tap to view the door or the back aisle without leaving the sale. *M*
- **Panic / silent alert** — long-press logo → text to owner + optional 911 info card; no visible change on screen. *M*
- **Delivery orders** (DoorDash/Uber/Grubhub) arrive as tickets on the register; accept/ready; no tablet farm. *M*
- **WhatsApp orders** — regulars text "2 samosa chai" to the store's WhatsApp; it lands as a ticket. Community stores run on WhatsApp already. *M*
- **Voice ring-up** — "two Marlboro Gold, one large coffee" (mic button, on-device model, cashier confirms). *M*
- **Camera item recognition** — hold produce/bakery items to the customer-screen camera; suggests the PLU. *M*

### 1.11 Self-checkout and second-lane modes
- **Customer-facing self-checkout mode** on the same hardware for low-risk baskets; age-restricted items lock and call the cashier. *M*
- **Line-buster** — a handheld (or Tap-to-Pay phone) rings the next customer while the counter is busy. *M*
- **Mobile register** — the owner's phone as a full backup register with Tap to Pay when the counter unit dies. *N*

---

## Part 2 — The Merchant App (the owner's second brain, in their pocket)

### 2.1 Live store, everywhere
- **Live sales ticker** — every sale as it happens; per register; per cashier. *L*
- **Today vs yesterday vs same day last week**, by hour; "you're up 12%." *L*
- **Cash in drawer right now**, per register; "drop needed." *N*
- **Camera live view** alongside the sales feed (see the sale and the cashier). *M*
- **Multi-store switcher** and roll-up for owners with 2–5 stores (very common). *L (switcher) / N (roll-up)*

### 2.2 Money, finally readable
- **Deposits** — what hits the bank tomorrow, by day, matched to batches. *L (once processor live)*
- **Fees, explained** — "You paid $412 this month: $290 card cost (interchange), $110 AD Pay, $12 network. Effective 2.5%." A pie, not a 5-page statement. Compare to their old processor's rate on onboarding. *N*
- **Card mix + savings coach** — "Debit is 61% of your volume. Pay-by-bank would have saved $211 this month." *M*
- **Dispute center** — chargeback arrives → push notification → upload receipt/camera clip → submitted. *N*
- **Sales tax report** — taxable/non-taxable by rate, exportable; quarterly filing pack. *N*
- **Accountant access** — read-only login for the CPA; QuickBooks/Xero sync. *N*
- **Profit, not just sales** — margin by item/category once costs are in; "tobacco is 31% of sales and 6% of profit." *N*
- **Cash advance / working capital** offer based on processing history (NRS Funding model; with a partner). *M*

### 2.3 Catalog and pricing from the couch
- **Item add/edit with photo** — snap the product, type price, done; pushed to all registers in seconds. *L*
- **Dual-price % per location**; preview card prices before pushing. *L*
- **Bulk price change** — "+5% on all drinks," or "match this vendor invoice." *N*
- **Price history** and who changed what. *N*
- **Promotions builder** — 2 for $5, mix and match, buy X get Y, happy hour, with start/end and per-store. *N*
- **Vendor invoice scan (AI)** — photo of the Coca-Cola invoice → line items parsed → cost updated → margin recalculated → "your price on Sprite 20oz is now below cost." *M*
- **Neighborhood price intelligence** — anonymized "stores like yours sell this at $2.49" (opt-in, aggregated across AD Pay). *M*
- **Shelf label print queue** — after price changes, print the labels from the register. *N*

### 2.4 Inventory and ordering
- **Stock levels, low-stock list, dead stock (no sale in 60 days)**. *N*
- **Reorder suggestions** from sales velocity and day-of-week pattern (the weekend spikes in the statements). *N*
- **Vendor list** with what they supply, delivery days, contact; **one-tap order text/email** to the vendor. *N*
- **Receive by scan** from the register; discrepancy report vs invoice. *N*
- **Shrink dashboard** — expected vs counted, by category; void/no-sale patterns by cashier. *N*

### 2.5 People
- **Staff list, PINs, roles, permissions** — changeable from the phone instantly. *L*
- **Hours and payroll export** from the time clock. *N*
- **Cashier performance** — sales/hour, voids, drawer variance, age-check compliance. *N*
- **Approve/deny requests** — voids, refunds, discounts, drawer opens — from a push notification. *M*
- **Shift schedule** with swap requests. *M*

### 2.6 Alerts that matter (push, SMS, WhatsApp — owner's choice)
- Register offline > 5 min; terminal offline; printer out of paper. *L*
- Drawer opened outside a sale; void/refund over $X; no-sale count spike. *L*
- End of day not closed by 1 a.m.; cash count short by > $Y. *N*
- Big-ticket sale; unusually slow hour; first sale of the day late (store didn't open?). *N*
- Chargeback received; deposit lower than expected. *N*
- **Daily WhatsApp summary** at closing — sales, cash, card, top items, staff hours. Owners read WhatsApp, not dashboards. *N*

### 2.7 Customers
- **Loyalty program setup** in 2 minutes — points or punch-card, by phone number. *N*
- **Customer list** — regulars, visits, spend; text a promo to the top 100 (TCPA-compliant opt-in at the customer screen). *N*
- **Tabs ("khata") ledger** — who owes what, reminders, pay-by-link. *M*
- **Reviews and complaints** — customer screen "how was it?" → owner sees it, not Google. *M*

### 2.8 Store operations
- **Open/close checklists** with photos (cooler temps, restroom, lottery count). *N*
- **Equipment and hardware** — request a replacement, track tickets. *N*
- **Documents vault** — licenses (tobacco, lottery, liquor), expiry reminders. *N*
- **Marketplace** — order AD Pay hardware, labels, receipt paper; enroll in scan data, delivery, gift cards. *N*
- **Support chat** with "share my screen from the register" one tap. *L*

---

## Part 3 — Admin (AD Pay's back office: onboarding, ops, money)

### 3.1 Onboarding that closes deals
- **Statement analyzer** — upload a Sola/NRS/Clover PDF → parsed → effective rate, interchange vs markup, savings under our pricing, a one-page PDF to hand the owner. Our best sales tool, built into admin. *L*
- **Merchant onboarding wizard** — business info, KYB via processor, pricing plan, dual-pricing setup, catalog template by vertical, hardware order, install date. *L*
- **Catalog templates** — c-store (2,000 common UPCs with names/sizes), liquor, deli; merchant edits prices, doesn't type names. *N*
- **Catalog import** from NRS/Clover/Square exports (the switch has to be painless). *N*
- **Setup QR generation** and printed install kit (QR + Wi-Fi card + support number). *L*
- **E-sign merchant agreement** and pricing schedule; storage. *N*
- **Referral / agent tracking** — who brought the store, residual split, payout report. *N*

### 3.2 Fleet and support (the one-person-supports-200-stores system)
- **Device page** — heartbeat, app version, network, printer/terminal/scanner status, queued events, last 200 log lines, config diff. *L*
- **Remote actions** — restart app, force sync, reprint, printer test, re-pair terminal, push config, roll back build, reboot device; all audited. *L*
- **Remote screen view/control** (via MDM) with cashier consent banner. *L*
- **Ticket replay** — full event timeline per sale incl. terminal request/response. *L*
- **Alert console** — fleet-wide: offline registers, stuck queues, terminals unreachable, high void rates. *L*
- **Support tickets** — linked to merchant/device/sale; SLA timers; canned fixes ("printer paper," "Wi-Fi changed"). *N*
- **Staged rollouts** — canary → 10% → all, by merchant group; kill switch per feature flag. *N*
- **Hardware inventory & RMA** — serials, which store, warranty, swap workflow. *N*
- **Runbooks** — one per alert, in the console, with the button that fixes it next to the text. *N*
- **Merchant health score** — sales trend, offline minutes, support tickets, fee complaints → churn risk list. *M*

### 3.3 Money and payments operations
- **Settlement & fee reconciliation** — processor settlement files vs our ledger, daily; exceptions queue. *L (once live)*
- **Residual/margin report** — per merchant, per month: volume, interchange, processor cost, our revenue, our margin. The Finix rate math, automated. *L*
- **Pricing plans** — dual pricing %, IC+ markups, flat rates, POS subscription, per merchant, with history. *L*
- **Billing** — POS subscription, hardware, paper, add-ons; invoices; failed payment dunning. *N*
- **Disputes desk** — all chargebacks across merchants; evidence packs; win-rate. *N*
- **Risk monitoring** — velocity, refund ratios, keyed-card spikes, MCC drift; freeze/notify workflow. *N*
- **Scan-data program admin** — enrollments, submissions, payouts received per store. *N*
- **Ad network admin** — campaigns, screens, impressions, payouts to stores. *M*

### 3.4 Product and configuration
- **Feature flags & vertical packs** per merchant; pack editor. *L*
- **Tax tables** by jurisdiction with effective dates; compliance rules (age by category by state). *N*
- **Global UPC library** — every item ever added across the fleet, deduped; suggestions to merchants. *N*
- **Receipt/label template editor**. *N*
- **Translations management**. *N*
- **API keys & webhooks** for partners (accountants, delivery, loyalty). *N*

### 3.5 Portfolio intelligence
- **KPIs** — active stores, volume, effective rate, margin, churn, support load, installs per week. *L*
- **Cohort views** — by vertical, by city, by referrer. *N*
- **Benchmarks** — anonymized "stores like yours" data that powers the merchant-side price intelligence. *M*
- **Investor/bank pack** — one-click portfolio report (volume, retention, margin) for the sponsor-bank conversation. *N*

---

## Part 4 — The end customer (who actually pays for all of this)
- Sees **both prices before paying**, every time. Honest, legal, and the reason dual pricing doesn't feel like a surcharge. *L*
- **Under 20 seconds** in and out. *L*
- **Change in big green numbers**; receipt by text; no paper unless wanted. *L / N*
- **Their language** on the screen. *N*
- **Loyalty by phone number**, no app, no card. *N*
- **Pay by bank and save**; **tab for regulars**; **round up for the block**. *M*
- **Never sees a processor's name**, a spinner, or "system down." *L*

---

## Part 5 — Signature features (pick the first three; each one is a story)

1. **Readable fees + savings coach** — the only POS that tells the owner what they pay and how to pay less. Grounded in the statements: nobody in those four stores can read their own bill.
2. **WhatsApp everything** — orders in, daily summary out, alerts, approvals. Meets these owners where they already live.
3. **Khata / store tab** — the paper notebook under every bodega counter, digitized, with reminders and pay-by-link.
4. **Vendor invoice AI** — photo → costs → margins → "you're selling below cost." Turns a register into a profit tool.
5. **Manager override from the phone** — the owner runs the store without standing in it.
6. **Pay-by-bank QR at the counter** — 3¢ instead of 3%; the store keeps the difference or shares it with the customer.
7. **Camera on the register + panic button** — safety features for stores that are open at 2 a.m.

---

## Part 6 — Sequencing note for dispatch
Everything tagged **L** goes into the v1 plan alongside the existing spec (it extends section 4 of the
spec; the spec's decisions still bind). **N** items become the v1.1–v1.3 roadmap after the first
stores are live. **M** items get their own design doc each; do not start one until three stores have
run 30 days on **L** without a truck roll.
