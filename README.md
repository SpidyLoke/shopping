# Kaimono Check

**Live app:** https://spidyloke.github.io/shopping/
**About page:** https://spidyloke.github.io/shopping/about/ (also linked at the bottom of Settings)

Phone web app for shopping in Japan. Snap a box, price tag or shelf label and it:

1. Reads the Japanese text (Google Cloud Vision)
2. Translates it to English (Google Cloud Translation)
3. Identifies the product and searches Shopee Malaysia and Carousell Malaysia for new and second-hand prices in RM (Gemini with Google Search grounding)
4. Converts the yen price to RM at the day's rate and gives a Buy / Marginal / Skip verdict
5. Saves every scan to history on your phone

It's a static site on GitHub Pages and installs to your home screen like an app. No server; your API key stays on your device.

### Outside Japan

It works anywhere, not just Japan. Gemini reads the price and its currency from the tag or listing (¥, RM, S$, NT$, ₩, ฿, HK$, US$, € and more) and everything is converted to RM at that day's rate.

- **In Malaysia** (a shop, or a screenshot of a Carousell, Shopee or Facebook listing): the price box says **Asking price** in RM, and the verdict says **Good price**, **Fair price** or **Overpriced** compared with other Malaysian listings, plus the deal labels (CeX pays more, under CeX and so on).
- **Elsewhere:** the price box shows the local price and its RM value. Japan's tax and tourist-refund switches only show for yen prices, and only yen purchases count towards the Trip tax-free totals.
- **Wrong currency?** Tap the symbol in the price box to pick another; the RM figure and verdict update.

## Setup

### 1. Google API keys (two keys)

Google won't let a restricted key cover the Gemini API alongside other APIs, so you need one key for Vision and Translate and a second for Gemini.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project and attach billing (Vision and Translation require it, even for free-tier usage).
2. Enable these three APIs under **APIs & Services → Library**:
   - Cloud Vision API
   - Cloud Translation API
   - Gemini API (Generative Language API)
3. **Cloud key:** **APIs & Services → Credentials → Create credentials → API key.** Edit it:
   - **Application restrictions:** Websites → add `https://spidyloke.github.io/*`
   - **API restrictions:** Cloud Vision API and Cloud Translation API
4. **Gemini key:** create a second API key the same way, with API restrictions set to **Gemini API** only and the same website restriction. (A key made in [Google AI Studio](https://aistudio.google.com/apikey) also works.)

Free tiers at time of writing: Vision gives 1,000 units a month per feature (each scan uses two: text and web detection), Translation gives 500,000 characters a month. Gemini grounded search is billed per search on the paid tier; check [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) for current rates.

### Background scanning (optional, recommended on iPhone)

Phones cut a web app's connections a few seconds after you switch away or close it, so a scan in progress fails. A free Google Apps Script "scan server" fixes that: the app hands each scan to it, it finishes the work on Google's side, and the app picks up the result next time it's open. It also sends you a Telegram message when each scan is done.

1. Go to [script.google.com](https://script.google.com) (same Google account) → **New project**. Rename it "Kaimono server".
2. Paste the short loader from [`server/Loader.gs`](https://raw.githubusercontent.com/SpidyLoke/shopping/main/server/Loader.gs) into `Code.gs` (below the sample `myFunction` is fine). Save. The loader fetches the real server code from this repo and re-checks it every 10 minutes, so server updates never need editing or redeploying. (You can paste the full [`server/Code.gs`](https://raw.githubusercontent.com/SpidyLoke/shopping/main/server/Code.gs) instead if you'd rather not load code from GitHub; then updates mean pasting it again and deploying a new version.)
3. **Deploy → New deployment →** ⚙ **Web app**. Execute as **Me**, Who has access **Anyone**. **Deploy**.
4. Authorise it. Google will warn the app isn't verified (it's your own script): **Advanced → Go to Kaimono server → Allow**. It needs permission to make web requests (Google APIs, CeX, ntfy).
5. Copy the **Web app URL** (ends in `/exec`).
6. In the app: **Settings → Background scanning**, paste the URL.
7. **Telegram notifications:** in Telegram open **@BotFather**, send `/newbot`, pick any name and copy the token. Paste it into the app, open your new bot in Telegram and tap **Start**, then tap **Link** in the app. You'll get a hello message.
8. Tap **Test notifications**, then **Save**. The test reports each hop: Telegram linked, app → your server, server → Telegram.

ntfy is still there under "Use ntfy instead", but ntfy rate-limits Google's shared servers, so notifications sent from Apps Script often get refused ([ntfy issue #1922](https://github.com/binwiederhier/ntfy/issues/1922)). Telegram doesn't have that problem.

Notes:
- The server uses the API keys already in the app; they're sent with each scan and never stored there. The first request from your app locks the server to it.
- Results are kept for 6 hours. While a scan is on the server the result page says so; you can close the app.
- With the loader, updates arrive by themselves. If you pasted the full `Code.gs` instead, update it with **Deploy → Manage deployments → ✎ → Version: New version**; the URL stays the same.
- The loader runs whatever is in `server/Code.gs` on this repo's main branch, with only the permission to make web requests (no access to Drive, Gmail or anything else in your account).
- If scans fail with "Requests from referer … are blocked", Apps Script didn't pass your site as the referrer. Make a second pair of keys with **API restrictions only** (no website restriction) and use those in the app.

Without a server, a scan cut off by leaving the app restarts by itself when you come back to the app.

### 2. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. The site goes live at `https://spidyloke.github.io/shopping/`.

### 3. On your phone

1. Open `https://spidyloke.github.io/shopping/`
2. Add to Home Screen (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen)
3. Tap the gear icon, paste both keys, save

## Using it

- **Take a photo** opens the camera; **Choose from gallery** for shots you took earlier.
- The yen price is read automatically. Tap it to correct it; the verdict updates live.
- **Tag price already includes 10% tax (税込):** untick for 税抜 tags so 10% is added.
- **Claim tourist tax refund:** knocks the 10% consumption tax off for purchases of ¥5,000 or more. Set it as the default in Settings.
- **Shopee MY / Carousell MY** buttons open a live search for the product, for when you want to eyeball listings yourself.

### Getting around

- **Bottom bar:** Scan, History, Trip and Settings sit at the bottom for one-handed use; buttons are larger throughout.
- **Back:** every page except Home has **Back** at the top left. From a scan it returns to wherever you opened it (History, Trip, a shelf); from History or Trip it goes Home.
- **Zoom the photo:** tap the photo on a result or shelf to open it full screen, then pinch or double-tap to zoom and drag to pan. With several photos, swipe sideways between them. It uses the full-size photo, not the thumbnail.
- **Buzz when ready:** the phone vibrates (Android) or chimes (iPhone, plus a haptic tap on iOS 18+) when a scan finishes, so you can keep browsing. Turn it off in Settings.

### While scanning

- **Quick scan** (switch on the home screen): only Shopee and Carousell are searched, for a faster, cheaper first look. **Run full check** on the result fills in Mercari, CeX (web), compatibility and the rest.
- **✎ Fix name:** type the right product name if Gemini got it wrong, and the scan re-prices without a new photo.
- **Ask:** under the prices, tap **Worth it?**, **Alternatives** or **Translate tag**, or type any question ("works with PC?", "is this the 2025 model?") for a short answer that knows the item, the tag and the prices. Answers are saved with the scan. There's no separate translation step any more: Gemini reads the Japanese directly, and **Translate tag** gives you the English when you want it.

### Keeping track

- **Trips:** name each trip in the Trip tab (e.g. "Osaka Nov 2026"). New scans go into the current trip; budget, spending, tax back and savings are per trip, and History can show one trip or all.
- **Search:** History searches item names, brands, stores and areas.
- **Refresh prices:** on the Favourites list (home or History), one tap re-checks the Malaysian prices for every favourite.
- **Select:** in History tap **Select** to pick scans, then favourite, mark as bought, delete (with Undo) or compare 2 to 3 of them.

### Where each price comes from

Tap **MY new**, **MY used** or **JP used** to see the listings behind that figure: platform, the listing title exactly as posted, its price and a link to open it. Each listing is marked **Same model**, or **Check model** when its title names a different variant (e.g. "Reloaded" when you're looking at the original) or Gemini wasn't sure. The box itself says "check model" when any listing behind it is flagged. If no listings came back, the figure is an estimate, and **Search … yourself** opens the search.

### Exact model check

Gemini reads edition words off the box (Reloaded, Pro, Lite, OLED, V2…) and the result shows the exact model it found and how it knew. When it isn't sure, the box turns amber and lists lookalikes with how to tell them apart; tap **It's …** to re-price the scan as that model. Price matching (CeX, same item at other stores) treats lookalike variants as different products.

### Product info: worth it?

Tap **Worth it?** in the Ask section for a Worth it / Depends / Probably not call with the reason, pros and cons, whether a newer model is out, and up to three better or better-value alternatives with prices. Turn on "Load product info on every scan" in Settings to get it automatically (one extra Gemini search per scan).

### CeX Malaysia

The app asks [CeX Malaysia](https://my.webuy.com)'s own site search for the same item (Google rarely indexes CeX prices, so this is far more reliable), ignoring accessories and other models; the card says **Live from CeX** and names the listing it matched. If CeX can't be reached (it's an unofficial endpoint and may block some regions), it falls back to Gemini's web search and says **Via web search**. The **CeX Malaysia sells** card shows its used price (and grade), and **CeX buys at** shows its trade-in offer in cash and voucher, which is roughly what you could resell it for at home. The verdict mentions CeX when it's cheaper than the Japan price, and the CeX Malaysia button opens the product or a search.

### Swipe to delete

Swipe any scan left in Recent, Favourites or History to delete it. An **Undo** bar stays up for 5 seconds; the saved photo is only removed after that.

### Malaysia compatibility

Every scan gets a **Works in Malaysia** card when it applies: 240V or 100V-only (Japan is 100V, Malaysia 240V with three-pin plugs), region locks, Japanese-only menus, Japan-only warranty, and oddities like forced camera shutter sounds. A real problem (e.g. a 100V rice cooker) turns "Buy it here" into **Cheap, but check it works in Malaysia**.

### Japan resale check

Gemini also checks **Mercari Japan** and **Yahoo! Auctions** for the same item second-hand. The price shows as a fourth card, and the verdict mentions it when it's at least 15% cheaper than the shop. Buttons open both searches in Japanese.

### More than one photo

One scan can use up to 5 photos of the same item, for example the front, the brand or size label and the price tag. Vision reads all of them and Gemini sees them together, which helps when the price and the model are on different labels. Three ways to add them:

- Pick several photos at once from **Gallery**.
- Tap **Add photo** on a result to add another angle or label; the scan re-reads everything with it included.
- In **Clothes** mode, each photo goes into a tray first; add more, then tap **Check price**.

A **+2** badge on the result photo shows the extra photos.

### Clothes

Switch the home screen to **Clothes** for clothing, shoes and bags. Photograph the whole piece, then add the brand label, size or care label and price tag. Gemini identifies it from the piece itself (logos, design, product codes on Uniqlo, GU and Muji tags, collaborations) rather than relying on text, reads the size and converts it to a rough Malaysian size (Japanese sizes often run small), and notes the material and colour. Prices come from the brand's Malaysian store, Zalora, and Shopee and Lazada brand stores for new, and Carousell for used. CeX is skipped (it doesn't sell clothes), and the Zalora button replaces it. In Used mode it lists visible wear and flags anything that looks like it may not be genuine. Clothes are only matched by product code (e.g. AY9150) or the exact same design and colourway: "brand + bomber jacket" in another colour or print doesn't count. When only similar pieces turn up, the verdict says **No exact match**, the price boxes say **Similar items only**, and each listing is marked **Similar item** (and **Sold** when it's gone), so the figures read as a rough guide rather than a Buy or Skip.

### Whole-shelf scan

Switch the home screen to **Shelf** and photograph a whole shelf or display case. You get every priced item listed with a cropped thumbnail, yen and RM. Tap **Check** on one, or **Check all prices**, and each becomes its own full scan in History.

### Favourites, bought list and trip budget

- **♥** on any scan (in lists or on the result) saves it to Favourites, shown on the home screen and as a History filter.
- **Mark as bought** on a result adds it to **Trip spending** (bag icon, top right): spend in yen and RM, estimated tax back, what's left of your RM budget, and a per-store, per-day tracker showing how far you are from the ¥5,000 tax-free minimum. It also totals how much you've **saved vs buying in Malaysia** (Malaysian price minus what you paid after the tax refund; second-hand buys are measured against Malaysian second-hand prices), with the saving on each bought item.

### Side-by-side compare

In History tap **Compare**, pick 2 or 3 scans, then **Compare**. Price, Malaysian prices, Japan resale, saving, verdict, condition, compatibility and distance line up in columns with the best value highlighted. The "Same item at other stores" list on a result has a shortcut to it.

For two different products (e.g. two versions of a tracker), tap **Which should I get?** at the top. Optionally say what matters to you first ("I use Android", "for travel"). Gemini looks up specs and reviews and answers with a pick, the reason, what it depends on if it can't know, and the differences that matter side by side. The pick is marked on its column and saved, so reopening the comparison shows it; **Ask again** re-checks.

### Rescan

Every scan in **Recent scans** and **History** has a ↻ button beside it, and the same button sits at the top of each result. It reruns whatever failed (red outline means something did) and refreshes the Malaysian prices, using the full-size photo saved on your phone.

### Stores and location

Each scan saves where you were (allow location when asked; turn it off in Settings). The **Where** card on a result shows:

- **Store name:** the shop name Gemini reads off the tag, or the name from OpenStreetMap. Tap to type your own.
- **Directions:** opens Google Maps back to that spot. **Move pin to here** fixes a bad GPS reading.
- **Same item at other stores:** every scan of the same product, cheapest first, with distance from you. Tap one to open it.

History has a **Nearest** sort for when you're deciding which shop to go back to.

### Second-hand shops

Switch the home screen to **Second-hand shop** before scanning at Hard Off, 2nd Street, Book Off, Sofmap and the like. Each scan then:

- Compares the Japan price against **Malaysian second-hand prices** (like for like), and calls it a skip if it's cheaper brand new at home. With no Malaysian used listings, it needs to be 30%+ under the new price to count as a buy.
- Shows a **Condition** card: the shop's grade (ランクA/B/C…) on that chain's own scale, in plain English. When a tag lists several grades (separate A and B units at different prices), each is listed with its price; tap the one you're buying and the verdict re-prices. A used tag (中古, a grade, ジャンク) switches the scan to second-hand comparison even in New mode.
- Also lists every issue on the tag ranked by severity. Red: junk, untested, sold as-is, no returns, no warranty. Amber: missing parts, no box, wear. Green: tested working, no scratches.
- Downgrades a "Buy" to **Cheap, but read the issues** when the tag has a serious issue.

A built-in keyword check flags issues the moment the text is read, so you still get the warnings if Gemini is slow or fails. Gemini's fuller read replaces it when it arrives. The **Second-hand item** switch on any result flips the comparison after the fact.

### Deal labels

Under Buy / Maybe / Skip, short labels say where the Japan price sits against what the item fetches at home. The one nearest above the Japan price wins:

| Label | Means |
| --- | --- |
| **CeX pays RM X more** | CeX Malaysia's cash (or voucher) buy price is above what you pay here, so you could sell it straight on |
| **Resells for RM X more** | It goes for more than this second-hand in Malaysia (Carousell, used Shopee) |
| **RM X under CeX** | Cheaper than CeX Malaysia's used price |
| **RM X under MY new** | Only cheaper than buying new at home |
| **RM X over MY new** | Dearer than new in Malaysia |
| **RM X over CeX** | Above CeX's used price, though still under the Malaysian second-hand price |
| **Cheaper on Mercari** | Japan's own second-hand market has it at least 15% cheaper |

Labels that mean you could make money back show first. On History, Home and Trip rows the badge itself carries the short form (**CeX +RM 115**, **Resell +RM 137**, **Under CeX**, **RM 100 off new**, **Dearer here**, **Over CeX**, **Mercari cheaper**), with any second label under the price. A problem comes before any deal: **Power issue** (or Region, Warranty…) when it won't work properly in Malaysia, **Check condition** for junk or as-is tags. Buy / Maybe / Skip only shows when there are no prices to compare. The **Resale profit** chip in History lists only those. Compare shows them in a **Deal** row.

### Verdict rules

| Verdict | When |
| --- | --- |
| Buy it here | Japan price is at least 10% below the typical new price in Malaysia |
| Buy if you want it new | Same, but second-hand in Malaysia is cheaper than Japan |
| Marginal | Japan is cheaper, but by less than 10% |
| Skip it | It's cheaper new in Malaysia |

Shipping, luggage allowance and warranty aren't factored in. Gemini flags Japan-only variants, voltage or region-lock issues in the notes.

### Gestures and shortcuts

- **Long-press a scan** (Home, History, Trip) for quick actions: open, favourite, mark bought, rescan, compare with others, delete.
- **Swipe a scan right** to favourite it; swipe left to delete.
- **Swipe in from the left edge** of the screen to go back.
- **Pull down** on a result to re-check its prices, or on Home, History or Trip to refresh the exchange rate, favourites and any scans that failed.
- **Undo** appears for a few seconds after favouriting, marking bought, deleting and every rescan (Undo after a rescan, a new photo or a corrected name puts the previous result back).
- **Filter chips** in History: Buy, Maybe, Skip, Used, Clothes and your most-visited stores.
- **Built-in camera:** tapping Take a photo opens a viewfinder inside the app. Item and Shelf scan the moment you press the shutter; Clothes lets you take several shots, then **Check**. The torch button appears where the phone allows it. iPhone may ask for camera permission again after the app has been closed for a while; turn Built-in camera off in Settings to use the iPhone camera instead. iPhone asks for camera permission the first time you open it after launching the app; after that the camera is kept ready for a minute, so reopening it doesn't ask again. Turn Built-in camera off in Settings to use the iPhone camera, which never asks.
- While a scan is loading, the result's layout shows straight away with placeholders that fill in as each price arrives.

## Settings

- **Gemini model:** defaults to `gemini-flash-latest`, Google's alias for the current Flash model, so it keeps working when versions retire. Pin a specific model ID here if you prefer.
- **Back up / Restore:** saves everything (scans, photos, trips, keys and the scan server pairing) to one file you keep in Files, and puts it back. A home-screen app's data is deleted when you remove it from the home screen, so back up first if you reinstall (for example to pick up a new app icon).
- **Layout and look** (applies straight away):
  - **Lists:** List, Compact (smaller rows, more on screen) or Grid (big photo tiles).
  - **Results:** Page, or Sheet (your photo fills the top and the result slides up over it).
  - **Theme** Auto, Light or Dark; **Text** Small, Default or Large; **Colour** indigo, green, red or black; **Show first** RM or ¥.
  - **One-hand mode:** bigger buttons, the content on Home sits lower, Back moves just above the tab bar and Settings opens from the bottom with Save at the bottom.
  - **Built-in camera** on or off.
- **Clear history:** deletes all saved scans from the phone.
- **API keys** and **Background scanning** fold away once set up. Saved keys and tokens are never shown or refilled; the box shows a hint like "Saved · AIza…x9Q2", and leaving it empty keeps what's saved. With no password-style fields and no form, iPhone doesn't offer to save a password. The × at the top closes Settings without saving.

## Development and tests

The app is plain static files (no build step). Tests run the real app in Chromium at phone size with Google, CeX and the exchange rate mocked, so no keys or network are needed:

```
npm install
npx playwright install chromium   # first time only
npm test                          # server tests, then app tests
npm run serve                     # the app on http://localhost:8124
```

- `tests/e2e/`: scanning (one or several photos, clothes, other currencies), deal labels, History gestures and Undo, Settings and backup, the built-in camera, Compare, and background scanning against the real server code.
- `tests/server/`: the scan server (`server/Code.gs`, `server/Loader.gs`) in a fake Apps Script sandbox.

GitHub Actions runs both on every push (`.github/workflows/test.yml`).

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Styling, light and dark mode |
| `app.js` | Camera, Google API calls, verdict logic, history |
| `sw.js` | Caches the app so it opens instantly and offline |
| `manifest.webmanifest`, `icons/` | Home-screen install |
