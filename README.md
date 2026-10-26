# Kaimono Check

**Live app:** https://spidyloke.github.io/shopping/

Phone web app for shopping in Japan. Snap a box, price tag or shelf label and it:

1. Reads the Japanese text (Google Cloud Vision)
2. Translates it to English (Google Cloud Translation)
3. Identifies the product and searches Shopee Malaysia and Carousell Malaysia for new and second-hand prices in RM (Gemini with Google Search grounding)
4. Converts the yen price to RM at the day's rate and gives a Buy / Marginal / Skip verdict
5. Saves every scan to history on your phone

It's a static site on GitHub Pages and installs to your home screen like an app. No server; your API key stays on your device.

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

### CeX Malaysia

The app asks [CeX Malaysia](https://my.webuy.com)'s own site search for the same item (Google rarely indexes CeX prices, so this is far more reliable), ignoring accessories and other models; the card says **Live from CeX** and names the listing it matched. If CeX can't be reached (it's an unofficial endpoint and may block some regions), it falls back to Gemini's web search and says **Via web search**. The **CeX Malaysia sells** card shows its used price (and grade), and **CeX buys at** shows its trade-in offer in cash and voucher, which is roughly what you could resell it for at home. The verdict mentions CeX when it's cheaper than the Japan price, and the CeX Malaysia button opens the product or a search.

### Swipe to delete

Swipe any scan left in Recent, Favourites or History to delete it. An **Undo** bar stays up for 5 seconds; the saved photo is only removed after that.

### Malaysia compatibility

Every scan gets a **Works in Malaysia** card when it applies: 240V or 100V-only (Japan is 100V, Malaysia 240V with three-pin plugs), region locks, Japanese-only menus, Japan-only warranty, and oddities like forced camera shutter sounds. A real problem (e.g. a 100V rice cooker) turns "Buy it here" into **Cheap, but check it works in Malaysia**.

### Japan resale check

Gemini also checks **Mercari Japan** and **Yahoo! Auctions** for the same item second-hand. The price shows as a fourth card, and the verdict mentions it when it's at least 15% cheaper than the shop. Buttons open both searches in Japanese.

### Whole-shelf scan

Switch the home screen to **Shelf** and photograph a whole shelf or display case. You get every priced item listed with a cropped thumbnail, yen and RM. Tap **Check** on one, or **Check all prices**, and each becomes its own full scan in History.

### Favourites, bought list and trip budget

- **♥** on any scan (in lists or on the result) saves it to Favourites, shown on the home screen and as a History filter.
- **Mark as bought** on a result adds it to **Trip spending** (bag icon, top right): spend in yen and RM, estimated tax back, what's left of your RM budget, and a per-store, per-day tracker showing how far you are from the ¥5,000 tax-free minimum. It also totals how much you've **saved vs buying in Malaysia** (Malaysian price minus what you paid after the tax refund; second-hand buys are measured against Malaysian second-hand prices), with the saving on each bought item.

### Side-by-side compare

In History tap **Compare**, pick 2 or 3 scans, then **Compare**. Price, Malaysian prices, Japan resale, saving, verdict, condition, compatibility and distance line up in columns with the best value highlighted. The "Same item at other stores" list on a result has a shortcut to it.

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
- Shows a **Condition** card: the shop's grade (ランクA/B/C…) in plain English, and every issue on the tag ranked by severity. Red: junk, untested, sold as-is, no returns, no warranty. Amber: missing parts, no box, wear. Green: tested working, no scratches.
- Downgrades a "Buy" to **Cheap, but read the issues** when the tag has a serious issue.

A built-in keyword check flags issues the moment the text is read, so you still get the warnings if Gemini is slow or fails. Gemini's fuller read replaces it when it arrives. The **Second-hand item** switch on any result flips the comparison after the fact.

### Verdict rules

| Verdict | When |
| --- | --- |
| Buy it here | Japan price is at least 10% below the typical new price in Malaysia |
| Buy if you want it new | Same, but second-hand in Malaysia is cheaper than Japan |
| Marginal | Japan is cheaper, but by less than 10% |
| Skip it | It's cheaper new in Malaysia |

Shipping, luggage allowance and warranty aren't factored in. Gemini flags Japan-only variants, voltage or region-lock issues in the notes.

## Settings

- **Gemini model:** defaults to `gemini-flash-latest`, Google's alias for the current Flash model, so it keeps working when versions retire. Pin a specific model ID here if you prefer.
- **Clear history:** deletes all saved scans from the phone.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Styling, light and dark mode |
| `app.js` | Camera, Google API calls, verdict logic, history |
| `sw.js` | Caches the app so it opens instantly and offline |
| `manifest.webmanifest`, `icons/` | Home-screen install |
