# AD Pay POS: test cases

Thanks for testing. AD Pay is a point-of-sale system for delis and corner stores. There are three apps:

- **Register**: the till the cashier uses at the counter.
- **Merchant app**: the store owner's phone app. You'll use it in a web browser.
- **Admin**: AD Pay's own back office.

Everything here is **demo data**. Nothing costs money, and no real card is ever charged.

Work through the numbered cases, and mark each one **Pass** or **Fail**. A case passes only if you see exactly what "Expected" says. If something is different, it's a Fail: note it (see "How to report a bug" at the end) and move on.

Use **Chrome** on a computer. Keep one tab per app. Do the sections in order, because some cases build on earlier ones.

---

## 1. Links and logins

| App | Link |
| --- | --- |
| Register | https://remix-nec-wales-correspondence.trycloudflare.com |
| Merchant app | https://criticism-contain-family-administrative.trycloudflare.com |
| Admin | https://enters-row-fork-email.trycloudflare.com |

The links change each time the system is restarted. If a link doesn't open, ask for the new links.

**Admin**
- Email: `admin@adpay.local`
- Password: `adpay-demo`

**Merchant app**: sign in with a phone number. No text message is sent: the code is always **`123456`**, and it's also shown on screen.

| Phone | Person | Store |
| --- | --- | --- |
| `2015550100` | Nadia Haddad, owner | Journal Square Deli & Grocery |
| `2015550101` | Luis Ortega, manager | Journal Square Deli & Grocery |
| `2015550142` | Kevin Walsh, owner | Bayonne Corner Mart (a separate business) |

**Register setup code.** A code connects the register to a store. **Use `JSQ3-DEMO`** (Journal Square · Jersey City · Register 3).

The other codes are `JSQ1-DEMO`, `JSQ2-DEMO`, `AST1-DEMO` and `BAY1-DEMO`. Only use them if a case says so.

**Register PINs.** At "Who's working?", tap a name, then enter the PIN:

| Name | Role | PIN | Store |
| --- | --- | --- | --- |
| Nadia Haddad | Owner | `2580` | Journal Square |
| Luis Ortega | Manager | `1357` | Journal Square |
| Maria Santos | Cashier | `2468` | Journal Square |
| Dev Patel | Cashier | `3690` | Journal Square |
| Kevin Walsh | Owner | `2580` | Bayonne Corner Mart |
| Aisha Khan | Cashier | `4826` | Bayonne Corner Mart |

Owners and managers can approve things a cashier isn't allowed to do. The register calls this an approval ("Who's approving?").

**Money in this store (Jersey City).** Most items are taxed at **6.625%**. Grocery, Tobacco and Lottery items are not taxed. The **card price is 4% higher** than the cash price. All the numbers in the cases below follow from this.

---

## 2. Known rough edges: please don't report these

- **No real card machine.** Card payments are simulated. They are approved, **except any card amount ending in .13, which is always declined on purpose.** If a normal test happens to ask for a card amount ending in .13, a decline is correct.
- **No real printer, cash drawer or barcode scanner.**
  - A "printed" receipt appears on screen in a box titled **"Receipt (printer preview)"**.
  - Opening the drawer shows a short black **"Drawer opened"** message.
  - "Scanning" means typing the barcode into the search box and pressing Enter.
- **Customer screen** is a second browser window. Your browser may ask you to allow pop-ups.
- **ID scanning** of driver's licences needs a real scanner and can't be tested here.
- **Lottery tab** in the merchant app is unfinished. Skip it.
- **Admin → Fleet → device page**: "Re-pair terminal", "Roll back build" and "Reboot device" are greyed out on purpose.
- **Admin → Money**: processor costs are typed in by hand; nothing is automatic yet. The statement analyzer has no PDF upload yet. Onboarding shows **KYB: not started**. All of this is expected.
- **Tax & compliance templates** say "draft". They are starting values, not legal advice.
- **The first time a page opens it can take 10–30 seconds**, and everything is a little slow, because it runs on one laptop over the internet.
- **The data already has history**: months of sales, and a couple of oddly named test items such as "bbbbbb". Sales totals in the merchant app and admin will not start at zero.
- **Other people may be testing at the same time**, so you may see sales that aren't yours.

---

## 3. Register

Open the Register link. Stay on the same register throughout (Jersey City · Register 3).

**R1. Pair the register**
1. Open the Register link.
2. Type `JSQ3-DEMO` in the code box and press **Pair register**.

Expected: the screen changes to **"Who's working?"** with **"Journal Square Deli & Grocery · Jersey City"** above it. It shows four people: Nadia Haddad (Owner), Luis Ortega (Manager), Maria Santos (Cashier), Dev Patel (Cashier).

**R2. Pairing code that doesn't exist**
1. Open the Register link in a *private/incognito* window.
2. Type `ZZZZ-0000`, then press **Pair register**.

Expected: the red text **"That setup code is invalid, used or expired"** appears, and you stay on the setup screen. Close the private window afterwards.

**R3. Wrong PIN**
1. At "Who's working?", tap **Maria Santos**.
2. Enter `1111`, then press **Enter**.

Expected: **"Wrong PIN (4 tries left)"**.

**R4. Lockout after five wrong PINs**
1. Tap **‹ Back**, then tap **Dev Patel**.
2. Enter `0000` and press **Enter**. Do this five times.

Expected:
- After the fifth try: **"Too many wrong PINs. Dev Patel is locked out on this register for 5 minutes."**
- Back on "Who's working?", Dev Patel's tile is faded and says **locked**.

**R5. Sign in**
1. Tap **Maria Santos**, enter `2468`, press **Enter**.

Expected: the sale screen opens. At the top right is **"Maria"** with **"Lock"**. On the left are categories (★ Favorites, Sandwiches, Drinks, Snacks, Tobacco, Lottery, Grocery, Household).

**R6. Ring an item**
1. Tap **Drinks**, then tap **Hot Coffee — Medium**.

Expected:
- The ticket on the right shows **Hot Coffee — Medium $2.25**, and "card $2.34" under it.
- Subtotal **$2.25**, Tax **$0.15**.
- Two totals: **Cash $2.40** and **Card $2.50**.

**R7. Tap twice = quantity 2**
1. Tap **Hot Coffee — Medium** again.

Expected:
- Still **one line**, now **"2 × Hot Coffee — Medium" $4.50**.
- Subtotal **$4.50**, Tax **$0.30**, **Cash $4.80**, **Card $4.99**.

**R8. Cash with quick amounts and change**
1. Press **Cash**. It asks you to **"Count the starting cash"**, because the drawer isn't started.
2. Type `10000` (= $100.00) and press **Start drawer with $100.00**.
3. The cash screen **"Cash — $4.80"** opens.

Expected quick buttons: **Exact, $5.00, $10.00, $20.00, $50.00, $100.00**.

4. Press **$20.00**.

Expected:
- **"Drawer opened"** flashes.
- **"Sale complete"** with **Change due $15.20**.
- Buttons **No receipt** / **Print receipt**.

5. Press **Print receipt**. A "Receipt (printer preview)" box appears.

Expected on the receipt:
- 2 × Hot Coffee — Medium $4.50
- Subtotal $4.50
- "Tax 6.625% on $4.50 … $0.30"
- **TOTAL $4.80**
- "Cash price applied"
- Cash $20.00, Change $15.20

**R9. Search**
1. In the search box ("Search name, UPC or PLU — or scan"), type `cheet`.

Expected: the tile **Flamin' Hot Cheetos 2.75 oz $2.29** is shown.

2. Tap it.

Expected: added to the ticket at **$2.29**. Clear the search (×).

**R10. Scan a barcode**
1. Click the search box, type `200000100131`, and press **Enter**.

Expected:
- **Hot Coffee — Medium $2.25** is added to the ticket.
- The search box empties.

**R11. Unknown barcode → new item**
1. In the search box type `990011223344` and press **Enter**.

Expected: a **"New item"** box saying "Barcode 990011223344 isn't in the catalog yet…".

2. Name: `Test Salsa 16oz`. Cash price: `3.49`.

Expected: "card $3.63" appears next to it.

3. Tap **Grocery**, then press **Add & ring up**.

Expected: **Test Salsa 16oz $3.49** is on the ticket.

**R12. Void an open ticket**
1. Press **Void ticket**.

Expected: the ticket empties ("Tap an item to start a sale."). Maria is allowed to do this, so no approval is asked.

**R13. Open-price item**

First do case **A6** in the Admin section, which creates "Deli by weight".

1. Back on the register, tap **Grocery**, then **Deli by weight**. Allow up to 15 seconds for it to appear.

Expected: a keypad **"Price — Deli by weight"** saying the card price follows automatically (+4%).

2. Type `637` and press **Ring up $6.37**.

Expected: **Deli by weight $6.37** on the ticket, card **$6.62**. Press **Void ticket** afterwards.

**R14. Age-restricted item**
1. Tap **Tobacco**, then **Marlboro Red — Pack**.

Expected: **"Check ID — 21+"** with "Marlboro Red — Pack is age-restricted…".

2. Press **Not verified**.

Expected: nothing is added.

3. Tap it again and press **ID checked — 21+**.

Expected:
- The ticket shows **Marlboro Red — Pack $14.00** with "21+ checked" under it.
- Cash **$14.00**, Card **$14.00** (not taxed, same price by card).
- Press **Void ticket** afterwards.

**R15. Hold and recall**
1. Ring **Buttered Roll** (Sandwiches, $1.99).
2. Press **Hold**.

Expected: the ticket empties, and a black **Held (1)** button appears.

3. Press **Held (1)**.

Expected: a list **"Held tickets"** with one ticket and a **Recall** link.

4. Press **Recall**.

Expected: the Buttered Roll ticket is back. Void it.

**R16. Card approved**
1. Ring **Hot Coffee — Medium** once.
2. Press **Card**.

Expected: **"Card price $2.50"**, "or $2.40 in cash", and a **Charge $2.50** button.

3. Press **Charge $2.50**.

Expected:
- **"Card — $2.50 · Customer: tap, insert or swipe on the card machine"** briefly.
- Then **Sale complete**.
- Press **Print receipt**: it shows **TOTAL $2.50**, "Card price applied", and a card line with a brand and four digits, e.g. **"VISA ****1234 APPROVED $2.50"** (the brand and digits vary).

**R17. Card declined (amounts ending .13)**
1. Tap **Grocery**. Ring **Breakfast Cereal** ($5.49) and **Whole Milk — Half Gallon** ($3.29).

Expected: **Cash $8.78**, **Card $9.13**.

2. Press **Card**, then **Charge $9.13**.

Expected: **"Declined — test card: amounts ending in .13 decline. Try again, another card, or cash."** The ticket is still open.

3. Press **Cash instead**, then **Exact**.

Expected: Sale complete, change **$0.00**. Choose **No receipt**.

**R18. Split: part cash, part card**
1. Ring **Hot Coffee — Medium** twice (Cash $4.80 / Card $4.99).
2. Press **Cash** and type `200` on the keypad (= $2.00).

Expected: a button **"Take $2.00 now, rest by card"**.

3. Press it.

Expected: the card screen shows **"Paid so far $2.00"**, **"Left to pay by card $2.91"**, and "or $2.80 in cash".

4. Press **Charge $2.91**.

Expected:
- Sale complete.
- The receipt (Print receipt) shows **TOTAL $4.91**, the line "Split: cash price on cash part", and both a Cash line and a card line.

**R19. Price check**
1. Press **Price check**.

Expected: the banner **"Price check — scan or tap an item to see its prices. Nothing is rung up."**

2. Tap **Sandwiches → Chopped Cheese Hero**.

Expected: a box **"Price check — not rung up"** with **Cash $10.99** and **Card $11.43**.

3. Press **Show cost and margin**.

Expected: it asks for a manager/owner PIN, because Maria can't see costs. Press **Cancel**.

4. Press **Done**, then **Price check** again to turn it off.

Expected: the ticket is still empty.

**R20. Reprint**
1. Press **Reprint last**.

Expected: a receipt preview for the last sale (the split sale from R18), marked **\*\*\* REPRINT \*\*\***.

**R21. Refund needs approval**
1. Press **Tickets**.

Expected: **"Tickets on this register"**.

2. Open the ticket from R16 (the $2.50 card sale).
3. Press **+** next to Hot Coffee — Medium, and pick a reason.

Expected: a button **"Refund $2.50 to card"**.

4. Press it.

Expected: **"Who's approving?"** lists Nadia Haddad and Luis Ortega.

5. Tap **Luis Ortega** and enter `1357`.

Expected: the refund completes, and the ticket shows **"1 returned"**.

**R22. Void a completed sale**
1. In **Tickets**, open the R8 sale ($4.80 cash).
2. Press **Void sale**, and approve as **Nadia Haddad** (`2580`).

Expected:
- The sale shows status **voided**.
- **"Drawer opened"** flashes (the $4.80 goes back in cash).

**R23. Training mode**
1. Press **Training**.

Expected:
- A black banner **"TRAINING — practice only. Nothing is saved, synced or charged; receipts say TRAINING."**
- The **Card** button is gone, and so are **Tickets** and **End of day**.

2. Ring **Hot Coffee — Medium**, then press **Cash → Exact → Print receipt**.

Expected: the receipt ends with **"\*\*\* TRAINING — NOT A SALE \*\*\*"**.

3. Press **Exit training**, then **Tickets**.

Expected: the training sale is **not** in the list.

**R24. Drawer: drop, paid-out, no-sale**
1. Tap the **Drawer** button at the top.

Expected: the "Drawer" panel shows when it was started, "by Maria Santos with $100.00".

2. Press **Safe drop**, type `5000` ($50.00), press **Next**, choose **Safe drop**, and press **Open drawer & record**.

Expected: Drops **$50.00**.

3. Press **Paid out**.

Expected: Maria isn't allowed, so it asks **"Who's approving?"**.

4. Approve as Luis (`1357`). Type `2000` ($20.00), press **Next**, choose **Vendor delivery**, type payee `Stella Bakery`, and press **Open drawer & record**.

Expected: Paid out **$20.00**.

5. Press **No sale**.

Expected: it asks for approval. Approve as Luis; "Drawer opened" flashes.

**R25. Blind count and shift close** (continue straight on from R24)
1. In **Drawer**, press **Close & count drawer**.

Expected: Maria is **not** shown what the drawer should hold. She only enters a count.

2. Type `2500` ($25.00) and press **Close with $25.00 counted**.

Expected: **"Drawer closed"**, Counted **$25.00**, Expected **$X**, and **"Short $Y"** in amber (never red), where Y = X − 25.00.

(X depends on the cash you took. If you followed R8–R24 exactly, X = $100.00 float + $4.80 (R8) + $8.78 (R17) + $2.00 (R18) − $4.80 (R22 void) − $50.00 drop − $20.00 paid out = **$40.78**, so **Short $15.78**. Training sales don't count.)

Write down X and Y for case C3.

**R26. End of day (Z-report)**
1. Press **End of day**.

Expected: **"End of day"** with a line "Since the last Z: N sales, $… (cash …, card …), tax …".

2. Press **Take Z & print**.

Expected:
- A printout starting **"Z-REPORT #1"** (a higher number if someone took one before).
- Sections: **BY CATEGORY**, **TAX**, **CASH DRAWER** (Counted $25.00, and the Short from R25), plus lines for Refunds, Voids, No-sale opens, Counterfeits refused.
- Then **"Z-report #… taken"**.

**R27. Offline selling and reconnect**
1. Press F12 to open Chrome DevTools, go to the **Network** tab, and set the throttling menu ("No throttling") to **Offline**. Don't reload the page.
2. Ring **Hot Coffee — Medium**.

Expected: a yellow banner **"Cash only right now — no connection to the card machine. Tap to retry."**, and the Card button shows **offline**.

3. Press **Cash**. Start the drawer if asked (type `10000`). Press **Exact**, then **No receipt**.

Expected:
- The sale completes normally.
- The status pill at the top says **"Offline · N queued"** (N is 1 or more).

4. Set DevTools back to **No throttling**.

Expected: within about 15 seconds the pill says **Synced**. The sale appears in the merchant app's **Tickets** tab (check in M3).

**R28. Customer screen**
1. Press **Customer screen ↗** at the top (allow pop-ups if asked).
2. Ring **Hot Coffee — Medium**.

Expected: the second window shows the item with **both** prices, **Cash $2.40** and **Card $2.50**, and updates as you ring. Void the ticket afterwards.

**R29. Lock and sign in as someone else**
1. Press **Lock** (top right).

Expected: back to "Who's working?".

2. Sign in as **Luis Ortega** (`1357`).

Expected: the sale screen, with "Luis" at the top.

---

## 4. Merchant app

Open the Merchant app link.

**M1. Sign in with a code**
1. Type `2015550100` and press **Text me a code**.

Expected: **"Enter the 6-digit code"**, with "Local dev — no SMS is sent. Your code: 123456".

2. Type `123456` and press **Sign in**.

Expected:
- The store name **Journal Square Deli & Grocery** and "Nadia Haddad" at the top.
- Tabs: **Sales, Tickets, Cash, Hours, Lottery, Items, Alerts, Staff, Help**.

**M2. Sales figures and live ticker**
1. Open **Sales** → **Today**.

Expected:
- A card **"Today so far · by [time]"**, with a comparison against yesterday and last week (e.g. "up 12% vs yesterday", or "nothing to compare with").
- A **Live** card showing **"● connected"**.
- Net sales, By hour, By register, **By cashier** (Maria Santos should appear), Voids/Refunds.
- A **Tax & compliance** card at the bottom.

2. Switch between **Today / 7 days / Month**.

Expected: the numbers change, and nothing errors.

**M3. Tickets**
1. Open **Tickets**.

Expected:
- Recent tickets with time, "Jersey City", register name, item count and total.
- The sales from section 3 are there, including the offline sale from R27.
- The voided R8 sale shows as **voided**.

**M4. Cash and over/short**
1. Open **Cash** → **Today**.

Expected:
- **Over / short** shows a negative total that includes the shortage from R25 (in amber, not red).
- Under **Drawer sessions**, tap the Register 3 session: it lists the drop, the paid-out, "counted $25.00 by Maria Santos", and **Should hold** = X from R25.
- **End of day (Z-reports)** lists the Z from R26.

**M5. Hours**
1. On the register (signed in as Luis), tap **Clock in** next to the name.

Expected: it changes to **"On the clock 0:00"**.

2. In the merchant app open **Hours** → **This week**.

Expected: **Luis Ortega** is listed with **"on the clock now"**.

3. Press **Export for payroll (CSV)**.

Expected: a CSV file downloads with a column per day.

**M6. Add an item with a photo**
1. Open **Items** → **+ Add item**.
2. Name `Test Muffin`, category **Sandwiches**, cash price `2.49`.

Expected: if a card price is shown, it is **$2.59**.

3. Press **Choose photo** and pick any image from your computer.
4. Save.

Expected:
- **"Added "Test Muffin"."**
- Within about 15 seconds, the register's **Sandwiches** page shows a **Test Muffin** tile with the photo and **$2.49**.

**M7. Edit an item**
1. In **Items**, open **Test Muffin** and change the cash price to `2.99`. Save.

Expected: on the register, the tile shows **$2.99** within about 15 seconds, without reloading.

**M8. Arrange keys**
1. **Items** → **Favorites** → **Arrange keys**.

Expected: a grid of the favourite keys.

2. Tap the first key, then tap the last key.

Expected: the first key moves to the last position.

3. Press **Save favorites**.

Expected: on the register, the **★ Favorites** page shows the new order within about 15 seconds.

**M9. Alerts and alert settings**
1. Open **Alerts**.

Expected: the list of alerts (it may include ones from other testers), and a **Registers** list showing Register 3 as **online**.

2. Open **Alert settings**, switch off **"Large refund or void"**, and press **Save alert settings**.

Expected: **"Saved."** Switch it back on and save again.

**M10. Staff and PINs**
1. Open **Staff** → **+ Add a person**.
2. Name `Test Cashier`, role **Cashier**, PIN `9876`. Press **Add**.

Expected: Test Cashier is listed.

3. On the register press **Lock**.

Expected: within about 15 seconds, **Test Cashier** appears on "Who's working?" and can sign in with `9876`.

**M11. Tenancy: one owner can't see another business**
1. Press **Sign out**. Sign in with `2015550142` and code `123456`.

Expected: the store name is **Bayonne Corner Mart**, the person is Kevin Walsh, and there's no way to switch to Journal Square.

2. Open **Tickets**.

Expected: **only "Broadway"** tickets. **No** "Jersey City" or "Astoria" tickets, and none of your test sales.

3. Open **Items**.

Expected: **no** "Test Muffin" and **no** "Test Salsa 16oz".

4. Sign out and sign back in as `2015550100`.

---

## 5. Admin

Open the Admin link.

**A1. Sign in**
1. Email `admin@adpay.local`, password `adpay-demo`. Press **Sign in**.

Expected: the **Merchants** page lists **Journal Square Deli & Grocery** (Jersey City, Astoria) and **Bayonne Corner Mart**. The menu shows: Merchants, Onboarding, Fleet, Alerts, Support, Sales, Money, Tax, Audit log.

**A2. Wrong password**
1. Sign out, and try the password `wrong`.

Expected: an error message; you are not signed in. Sign back in correctly.

**A3. Merchant tabs**
1. Open **Journal Square Deli & Grocery**.

Expected: tabs **Sales, Cash, Catalog, Staff, Plan & setup**. Each one opens without an error.

2. In Sales, check the **Latest tickets** list.

Expected: your sales from section 3 are there.

**A4. Catalog edit**
1. **Catalog** tab. Find **Snickers** in the item list and open it.

Expected: cash **$1.99**, card "Automatic: cash + 4%".

2. Change the cash price to `2.09` and press **Save changes**.

Expected: a green message with a new catalog version. Keep the register open for case C1.

**A5. Tax & compliance**
1. **Catalog** tab. Set "Priced at location" to **Astoria**.
2. Open **Tax & compliance at Astoria** → **Edit** → **+ Add rate**.
3. Enter class `standard`, rate `9`, date `2099-01-01`. Press **Save tax & compliance**.

Expected: a saved message.

4. Open **Tax** in the menu.

Expected:
- Astoria (under NY) shows **Sales tax today 8.875%**.
- Under Scheduled: **"standard 9% from 2099-01-01"**.
- Jersey City (under NJ) shows **6.625%**.

**A6. Create an open-price item** (needed for R13)
1. **Catalog** (Jersey City) → **+ New item**.
2. Name `Deli by weight`, category **Grocery**, tick **Open price**, leave the cash price empty. Press **Add item**.

Expected: the item list shows Deli by weight with price **"open"**.

**A7. Onboarding wizard**
1. **Onboarding** → **+ New merchant**. Go through the six steps:
   - Business: store name `Tester Deli`.
   - Owner: `Test Owner`, phone `9175550188`.
   - Location: state **NJ**.
   - Pricing: defaults.
   - Install: install date tomorrow.
2. On **Review**, press **Create merchant**.

Expected:
- **"Merchant created with 1 register"**.
- Tester Deli is in the pipeline table: Status **Setting up**, KYB **not started**, Registers paired **0 / 1**.

3. Click **print the install kit** → **Issue codes**.

Expected: one card for "Tester Deli · Main · Register 1", with a **QR code** and a setup code under it.

**A8. Fleet and a remote action**
1. **Fleet**. Find **Register 3 (new)** (Journal Square, Jersey City).

Expected: it's shown as online, with a recent "last seen".

2. Open it (the device page).

Expected: heartbeat, app version, queued events, and a list of recent log lines.

3. Press **Sign cashier out**.

Expected:
- Within a few seconds, the action's status in the page's action list becomes succeeded, with **"Signed out Luis Ortega"** (or whoever was signed in).
- **The register returns to "Who's working?"** (this is also case C5).

**A9. Alert console**
1. Open **Alerts**.

Expected:
- A list of open alerts.
- Within 2 minutes of R25, it includes **"Register 3 (new): drawer counted $… short"** (see C4).

**A10. Money and the statement analyzer**
1. **Money** → **KPIs**.

Expected: Stores live, Registers paired, Volume, Our revenue, Margin (may show "—"), Quiet stores, Installs per week.

2. **Statement analyzer**. Fill in the fields as follows:

| Field | Value |
| --- | --- |
| Store | `Test Bodega` |
| Processor | `Clover` |
| Card volume | `42000` |
| Transactions | `2800` |
| Total card fees | `1386` |
| Interchange | `1008` |
| POS per month | `79` |
| Registers | `2` |
| Dual pricing % | `4` |
| Subscription | `49.00` |

Expected: They pay today **$1,465.00**, Effective rate **3.3%**, Markup over interchange **0.9%** ($378.00). The dual-pricing offer says **"Costs $49.00 a month · saves $1,416.00 a month ($16,992.00 a year)"**.

3. Press **Save & open one-pager**.

Expected: a new tab with a one-page comparison titled "Test Bodega", and a **Print / save as PDF** button.

**A11. Audit log**
1. Open **Audit log**.

Expected: recent entries for your actions, e.g. the Snickers price change, the onboarding of Tester Deli, the remote action. Each shows who did it and when.

---

## 6. Across apps

**C1. Price change reaches an open register without reloading**
1. Keep the register open on **Snacks** (sign in if needed). Do not reload it.
2. In Admin, do **A4** (Snickers → $2.09).

Expected: within about 15 seconds, the register's Snickers tile shows **$2.09**. Afterwards, set Snickers back to `1.99` in Admin.

**C2. A sale appears in the live ticker**
1. Keep the merchant app open on **Sales → Today** (Live card showing "● connected").
2. On the register, ring **Hot Coffee — Medium** and pay **Cash → Exact**.

Expected: within about 5 seconds, a new row at the top of the Live card shows the time, "Register 3 (new) · Jersey City", the cashier's name, and **$2.40**.

**C3. Shift close appears in the merchant app**
1. After R25, open the merchant app → **Cash** → **Today**.

Expected: the Register 3 session shows the same shortage (Y) as the register showed, and "counted $25.00 by Maria Santos".

**C4. An alert fires and arrives**
1. After R25 (a count more than $5 short), wait up to 2 minutes.

Expected:
- Merchant app → **Alerts** shows **"Register 3 (new): drawer counted $Y short"**.
- The same alert appears in Admin → **Alerts**.

**C5. A remote action takes effect on the register**
1. Sign in on the register as anyone.
2. In Admin → Fleet → Register 3 (new), press **Sign cashier out**.

Expected: within a few seconds, the register shows **"Who's working?"** without you touching it.

**C6. New staff reaches the register**

Same as **M10**, step 3. Expected: Test Cashier can sign in on the register.

---

## 7. How to report a bug

For each Fail, send one message with:

1. **App**: Register, Merchant app or Admin.
2. **Test number**: e.g. R18.
3. **What you did**: the exact steps, and what you typed.
4. **What you expected**: copy the "Expected" line.
5. **What happened instead**: the exact text on screen, and a screenshot if you can.
6. **Time**: the date and the time to the minute, with your time zone (e.g. "Sep 25, 3:42 pm ET"). We use it to find the moment in the logs.

One bug per message is easiest. If something breaks so badly you can't continue, say which test you reached.
