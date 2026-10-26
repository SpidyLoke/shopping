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
