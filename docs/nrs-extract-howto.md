# How to get a store's NRS price book with real barcodes

A step-by-step guide for bringing a store's items over from NRS to AD Pay, done sitting with the
owner. You don't need to be a developer: you copy one block of text into the browser and it saves a
file. It takes about 10 minutes the first time. The technical write-up is
[`nrs-migration-method.md`](nrs-migration-method.md).

## What the trick is, and why it works

NRS has an **Export** button on its price book, but the file it gives you **scrambles every
barcode**: instead of `049000028911` you get a long jumble of letters and numbers. Items imported
from that file can't be scanned until someone scans each one by hand.

The NRS website itself still has the real barcodes. When you open the price book page, the page
asks NRS's server for the items, a page of 25 or so at a time, and the server sends them back in
plain text, real barcodes included. That's what you see in the table on screen.

The server only answers the NRS page itself; any other website or program is refused. So we don't
go around the page. **We ask the page's own table to load every item at once**, the same request it
makes when you click "next page", just bigger. Then we save what it loaded as a file.

- Nothing is changed in NRS: it only reads.
- You don't type any password, store number or code into the snippet. It finds the store number
  from the page, and it never needs the login code: the table already has it, and the snippet never
  shows or saves it.

## Before you start

- **Sit with the owner.** It needs their own NRS login. See *Only with the owner, on their login*
  below.
- Use **Google Chrome** on a Windows PC or a Mac. Microsoft Edge works the same way.
- Have AD Pay's merchant app open in another tab if you want to import straight away (step 8).

## Step by step

1. **The owner signs in to the NRS merchant portal** in Chrome, on your computer or theirs.
2. **Open Pricebook**, then the list of items: the page with the table of items, a search box and
   page numbers at the bottom. Wait until the table shows items.
3. **Look at the item count** at the bottom of the table, something like "Showing 1 to 25 of 9,284
   entries". Write down the last number (9,284 here). That's how many items the store has.
4. **Open the browser's developer console:**
   - Windows: press **Ctrl + Shift + J**. You can also press **F12** and click the **Console**
     tab.
   - Mac: press **Cmd + Option + J**.
   - Or: right-click anywhere on the page, choose **Inspect**, then click the **Console** tab.

   A panel opens with a blinking cursor next to a `>` sign.
5. **Allow pasting (first time only).** Chrome blocks pasting into the console the first time, to
   protect people from scams. If you see a warning that says to type *allow pasting*, click in the
   console, type `allow pasting` and press **Enter**.
6. **Copy the whole block below**: every line from `(async () => {` to the last `})();`. Click in the
   console, paste (**Ctrl + V**, or **Cmd + V** on a Mac) and press **Enter**.

```js
(async () => {
  const say = (...a) => console.log('%c[NRS export]', 'font-weight:bold;color:#0a7f3f', ...a);
  const warn = (...a) => console.log('%c[NRS export]', 'font-weight:bold;color:#c8102e', ...a);
  try {
    // 1. Find the price-book table: on this page, or inside a frame of it.
    const places = [window];
    for (let i = 0; i < window.frames.length; i++) {
      try { if (window.frames[i].document) places.push(window.frames[i]); } catch (e) { /* a frame from another site: skip */ }
    }
    const tables = [];
    for (const w of places) {
      const $ = w.jQuery;
      if (!$ || !$.fn || !$.fn.dataTable) continue;
      for (const node of $.fn.dataTable.tables({ visible: false, api: false })) {
        const dt = $(node).DataTable();
        let url = '';
        try { url = String(dt.ajax.url() || ''); } catch (e) { /* no address: a table filled by the page itself */ }
        const info = dt.page.info();
        const score = (/pbitems/i.test(url) ? 100 : 0) + (/pbitem|pricebook/i.test(node.id || '') ? 50 : 0);
        tables.push({ dt, url, total: info.recordsTotal || 0, score });
      }
    }
    tables.sort((a, b) => b.score - a.score || b.total - a.total);
    const t = tables[0];
    if (!t) {
      warn('No price-book table found on this page. Open the Pricebook items list, wait until it shows items, then paste this again.');
      return;
    }
    const dt = t.dt;
    const serverSide = !!dt.settings()[0].oFeatures.bServerSide;
    const store = ((t.url.match(/\/pbitems\/(\d+)/) || location.href.match(/(\d{4,})/) || [])[1]) || 'store';
    say(`Found the price book of store ${store}. The portal says it has ${t.total} items. Reading them all…`);

    // Wait for the table to fetch and draw after `go()` (the same request the page makes when you change pages).
    const drawAfter = (go) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The portal took more than 3 minutes to answer.')), 180000);
        dt.one('xhr.nrsexport', (e, s, json) => {
          if (json == null) { clearTimeout(timer); reject(new Error('The portal refused to send the items. Are you still signed in?')); }
        });
        dt.one('draw.nrsexport', () => { clearTimeout(timer); resolve(); });
        go();
      });

    // 2. Everything on one page: clear any search, ask for more rows than the store has.
    const pageLenBefore = dt.page.len();
    let rows;
    if (serverSide) {
      await drawAfter(() => dt.search('').columns().search('').page.len(Math.max(t.total, 10000) + 100).draw());
      rows = dt.rows().data().toArray();
      const total = dt.page.info().recordsTotal;
      // The portal sent fewer than it has (a cap on page size): read the rest page by page.
      if (rows.length && rows.length < total) {
        const per = rows.length;
        say(`The portal sends at most ${per} at a time; reading the rest in pages…`);
        await drawAfter(() => dt.page.len(per).draw());
        rows = dt.rows().data().toArray();
        for (let p = 1; rows.length < total && p < 1000; p++) {
          await drawAfter(() => dt.page(p).draw('page'));
          const chunk = dt.rows().data().toArray();
          if (!chunk.length) break;
          rows = rows.concat(chunk);
        }
      }
    } else {
      dt.search('').columns().search('').draw();
      rows = dt.rows().data().toArray();
    }

    // Rows as plain objects with the portal's own field names (upc, name, dept, cents…).
    if (rows.length && Array.isArray(rows[0])) {
      const names = dt.settings()[0].aoColumns.map((c, i) => (typeof c.mData === 'string' ? c.mData : c.sTitle || `col${i}`));
      rows = rows.map((r) => Object.fromEntries(r.map((v, i) => [names[i], v])));
      warn('This table gives rows as lists, not named fields: the file may not import. Send it to AD Pay to check.');
    }
    const seen = new Set();
    rows = rows.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });

    // 3. Check what we got.
    const total = serverSide ? dt.page.info().recordsTotal : dt.rows().count();
    const codes = rows.map((r) => String((r && (r.upc ?? r.Upc)) ?? '').trim());
    const real = codes.filter((c) => /^\d{12,13}$/.test(c)).length;
    const short = codes.filter((c) => /^\d{8}$|^\d{14}$/.test(c)).length;
    const scrambled = codes.filter((c) => c.length > 30).length;
    const none = codes.filter((c) => !c).length;
    if (rows.length === total) say(`✓ ${rows.length} items read: the same as the portal's ${total}.`);
    else warn(`✗ ${rows.length} items read, but the portal says ${total}. Don't use this file: see "If it didn't work".`);
    say(`Barcodes: ${real} with 12–13 digits (normal), ${short} with 8 or 14 digits (also fine), ${none} empty, ${scrambled} scrambled.`);
    if (scrambled) warn('Some barcodes are scrambled: this is not the plain price book. See "If it didn\'t work".');
    console.table(rows.slice(0, 8).map((r) => ({ barcode: r.upc, name: r.name, department: r.dept, price_cents: r.cents })));

    // 4. Save the file to Downloads.
    const file = `nrs-pricebook-${store}-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    say(`Saved ${file} (${(blob.size / 1048576).toFixed(1)} MB) to your Downloads folder.`);

    // Put the table back the way it was on your screen. Nothing in NRS was changed.
    if (serverSide) dt.page.len(pageLenBefore).draw();
  } catch (e) {
    warn('It stopped:', e && e.message ? e.message : e);
  }
})();
```

7. **Wait for the messages.** Lines starting with **[NRS export]** appear in green. It usually takes
   5 to 30 seconds; a very large store can take a couple of minutes. When it's done:
   - the last line says `Saved nrs-pricebook-<store>-<date>.json … to your Downloads folder`;
   - Chrome shows the download (top right). If Chrome asks whether this site may download files,
     click **Allow**.
8. **Import it into AD Pay:** merchant app → **Items → Import** → **Choose the NRS file** → pick
   that file → **Preview**. Check the preview (next section), then press **Import**. Admin can do
   the same from the merchant's **Catalog → Move from NRS**.

You can close the console afterwards (the ✕ at its top right, or the same keys again). The table on
screen goes back to how it was.

## How to check it worked

In the console:

- **Item count:** the line should say `✓ 9284 items read: the same as the portal's 9284.` with the
  same number you wrote down in step 3. If it says `✗ … but the portal says …`, don't use the file
  (see below).
- **Barcodes:** the line `Barcodes: … with 12–13 digits (normal) …` should cover nearly every item.
  A handful of 8- or 14-digit ones is fine. **Scrambled** should be **0**.
- **Spot-check:** the small table under it shows the first 8 items. The **barcode** column should be
  plain numbers of 12 or 13 digits, like `049000028911`. Pick one, find that product on the shelf,
  and compare it with the number under the barcode on the package.

In AD Pay's import preview:

- "Will import **N of N** items" is the same count again.
- "Barcodes: **N real product barcodes**, …" should be almost all of them.
- Store-made codes starting with 2 (deli, bakery) are normal and are listed separately.

## If it didn't work

| What you see | What to do |
| --- | --- |
| Pasting does nothing, or a warning about pasting | Type `allow pasting` in the console, press Enter, then paste again (step 5). |
| `No price-book table found on this page` | You're not on the items list, or it hadn't finished loading. Open Pricebook → items, wait for the table to show items, then paste again. |
| `The portal refused to send the items. Are you still signed in?` | The login timed out. Reload the page (the owner may need to sign in again), then paste again. |
| `The portal took more than 3 minutes to answer` | NRS is slow right now or the store is very large. Wait a minute and try again, ideally when the store isn't busy. |
| `✗ … items read, but the portal says …` | Run it again: a search box or filter may have been in use (the snippet clears it), or the connection dropped. If it keeps happening, send AD Pay a screenshot of the console. |
| `Scrambled` is more than 0, or barcodes look like long letters and numbers | That's the scrambled Export file, not this method. Make sure you pasted the snippet on the items table page, not a file from the Export button. |
| The `✓` line appeared but no file downloaded | Look at the top right of Chrome: allow downloads for this site if it asks, then run it again. Also check your Downloads folder. |
| Red error text that isn't from `[NRS export]` | NRS may have changed its website. Take a screenshot of the console and send it to AD Pay. |
| The table is empty or says "No data" | The store has no items in that list, or a location / department filter is set on the page. Clear the page's filters and try again. |

The snippet is safe to run more than once. Each run makes a new file; use the newest one.

## Only with the owner, on their login

- This needs **the owner's own NRS login**. Do it **with the owner, at the counter or on a call
  where they sign in**.
- **Never ask for, write down or keep their NRS password.** The snippet doesn't need it.
- It only **reads** the price book. It doesn't change any price, item or setting in NRS. Don't
  click anything else in their NRS account while you're there.
- If NRS shows a different screen, a message you don't recognise, or asks to confirm anything,
  **stop** and ask the owner. Don't click through it.

## The file is the store's whole price book

The file has **every item the store sells, with its prices, departments and (if entered) costs**.
That's the store's business information. Treat it like a bank statement:

- Keep it on your own computer, import it, then **delete it** from Downloads.
- Don't email it around, put it on a shared drive, or post it in a group chat.
- If you need AD Pay to look at a file, ask how to send it privately.
