// The scan prompt, shared by the app (own-key scans) and the Kaimono backend (functions/), so both
// ask Gemini exactly the same thing. Plain ES module with no browser or Node APIs.

const yen = (n) => `¥${Math.round(n).toLocaleString('en-GB')}`;

// ---------- barcodes ----------
// JAN/EAN-13, EAN-8 and UPC-A numbers in the tag text, kept only if the check digit is right.
// Printed numbers are often grouped ("4 902370 548495"), so groups split by one space or hyphen are joined.

export function gtinValid(code) {
  const d = [...code].map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((t, n, i) => t + n * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function findBarcodes(text) {
  const found = [];
  // Each run of digit groups ("¥3,980 4 902370 548495" gives 980, 4, 902370, 548495) is tried as
  // every stretch of whole neighbouring groups, so a price or phone number next to it doesn't hide it.
  for (const run of String(text || '').match(/\d+(?:[ -]\d+)*/g) || []) {
    const groups = run.split(/[ -]/);
    for (let i = 0; i < groups.length; i += 1) {
      let code = '';
      for (let j = i; j < groups.length && code.length < 13; j += 1) {
        code += groups[j];
        // 13-digit codes starting with 2 are the shop's own stock labels (Book Off, Hard Off): they find nothing online.
        // EAN-8 only as one unbroken number: joined short groups are usually dates or prices.
        if (![8, 12, 13].includes(code.length) || (code.length === 8 && j > i) || /^0+$/.test(code) || (code.length === 13 && code[0] === '2') || !gtinValid(code) || found.includes(code)) continue;
        found.push(code);
      }
    }
  }
  // Japanese JAN codes (45, 49) first, then other 13-digit, then the rest.
  const rank = (c) => (/^4[59]/.test(c) && c.length === 13 ? 0 : c.length === 13 ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b));
}

export const BARCODE_RULES = (codes) => `BARCODE: a barcode number (JAN/EAN-13, EAN-8 or UPC-A: 8, 12 or 13 digits printed under the bars; Japanese JAN codes start with 45 or 49) pins down the exact product and variant. ${codes.length
  ? `These barcode numbers were found in the text: ${codes.join(', ')}. Search the first one (in quotes) before anything else`
  : 'If you can read one in the OCR text or the photo, search it (in quotes) before anything else'}, and trust what it identifies over a visual guess. Put the number you used in "barcode". Ignore barcodes that are the shop's own stock labels (they find nothing). In "identified_by" say what pinned the product down: "barcode", "product code", "label text" or "appearance".
`;

export const CLOTHES_RULES = `CLOTHES: this is clothing, shoes, a bag or another fashion item. Identify it from the whole piece as much as from any text: logos, label and tag wording, product or style numbers (Uniqlo, GU and Muji print one on the tag), collaboration names, distinctive design or print, hardware such as zips and buttons, and fabric. Read the size from the size label or tag and give the rough Malaysian/UK equivalent (Japanese sizes often run a size smaller). Read the main material from the care label if shown.
For Malaysian prices check the brand's own Malaysian online store if it has one (e.g. uniqlo.com/my), Zalora Malaysia (zalora.com.my), and official brand stores on Shopee and Lazada Malaysia for new; Carousell Malaysia for used. CeX does not sell clothes: return null for cex_my. For second-hand pieces list visible wear (stains, pilling, fading, holes, worn soles) as condition issues, and add a medium-severity issue if anything suggests it may not be genuine. In my_compat give one "Size" entry with the size conversion (status "warn" if it may fit small) instead of voltage or region checks.
MATCHING CLOTHES: a listing is only the same item if it shows the same product or style code, or clearly the same design: the same model name, the same colourway, and the same prints, logos, embroidery and details. Brand plus garment type is NOT a match: an "adidas MA-1 bomber" in olive with a big ORIGINALS print is a different item from a plain navy one, and so is another season's version. Search by the product code first (e.g. "AY9150"), then brand + model name + colour. For each listing set "exact_model" true only when the code or the full design matches, and say how in "match_note". Base my_new and my_used only on exact matches; if you can only find similar items, list them with exact_model false, use them for the figures, and set "prices_are_similar": true in the clothing key. Put the product code in search_query when there is one.
Add a "clothing" key to the JSON: { "size_on_tag": "size as printed or null", "size_my": "rough Malaysian/UK size or null", "material": "main fabric or null", "product_code": "product or style number or null", "colour": "colour in English or null", "prices_are_similar": false }.
`;

export function buildPrompt({ ocrText, webGuess, secondHand, focus, override, quick, photos = 1, clothes = false }) {
  const codes = ocrText && !ocrText.includes('{{') ? findBarcodes(ocrText) : [];
  return `You are helping a Malaysian shopper decide whether an item is worth buying at the price shown, compared with buying it in Malaysia. They are usually in a shop in Japan, but may be shopping in Malaysia itself (a shop, a market, or a screenshot of a Carousell, Shopee, Mudah or Facebook listing) or in another country.

${photos > 1
    ? `The ${photos} attached photos all show the same item (for example the whole item, a brand or size label, and the price tag). Use them together.`
    : 'The attached photo shows a product, box, price tag, shelf label or an online listing.'}
OCR text from the photo${photos > 1 ? 's' : ''}:
"""
${ocrText || '(none detected)'}
"""
Google's visual best guess for the photo: "${webGuess || 'none'}"
${focus ? `\nThe photo shows a whole shelf with several products. Evaluate ONLY this one: "${focus.name}"${focus.yen ? `, priced ${yen(focus.yen)}` : ''}. Ignore every other product in the photo.\n` : ''}${override ? `\nThe shopper has checked the box and confirmed the exact product is: "${override}". Treat that as certain and price that exact model.\n` : ''}${secondHand ? '\nThe shopper is looking at a second-hand item (e.g. Hard Off, 2nd Street or Book Off in Japan, or a used listing). When searching Malaysia, prioritise second-hand listings in similar condition.\n' : ''}
${quick ? 'QUICK MODE: keep this fast. Only search Shopee and Carousell Malaysia. Skip CeX, Mercari, Yahoo Auctions and the Malaysia compatibility check, and return null or empty lists for cex_my, jp_used_yen and my_compat.\n' : ''}${BARCODE_RULES(codes)}${clothes ? CLOTHES_RULES : ''}
Tasks:
1. Identify the exact product: brand, model, size or capacity, and above all the exact variant. Words like Reloaded, Pro, Lite, OLED, Slim, Edge, V2, Mk II, 2nd Gen, Digital Edition or a special edition usually mean a different product at a different price (e.g. "Victrix Pro BFG" and "Victrix Pro BFG Reloaded" are different controllers). Read these words from the box, tag or the product itself and say where you saw them. If the photo doesn't show enough to tell lookalike variants apart, say so and list them with how to tell them apart.
2. Read the asking price and its currency from the photo or OCR text: ¥ or 円 = JPY, RM = MYR, S$ = SGD, NT$ = TWD, ₩ = KRW, ฿ = THB, HK$ = HKD, US$ = USD, and so on; use the shop's country if no symbol is shown. In Japan, if both tax-inclusive (税込) and tax-exclusive (税抜) prices are shown, use the tax-inclusive one and say whether the number includes Japan's 10% consumption tax. For a listing screenshot use the listed price. Use null if no price is visible.
3. Use Google Search to find current prices in Malaysia, in RM, for the same product:
   - New: Shopee Malaysia (shopee.com.my). If Shopee has none, use Lazada Malaysia or official Malaysian retailers.
   - Second-hand: Carousell Malaysia (carousell.com.my), plus used listings on Shopee Malaysia.
   Only use Malaysian listings priced in RM. Exclude accessories, cases, spare parts and listings for a lookalike variant: they are a different product, even if most of the name matches. Never invent listings, prices or URLs; if you cannot find any, use null or an empty list.
   Also check CeX Malaysia (my.webuy.com), which sells graded used stock: search my.webuy.com for the exact model. Its product pages show "WeSell for" (its selling price), "WeBuy for cash" and "WeBuy for voucher" prices in RM.
   Also search Japan's second-hand market for the same item in comparable condition: Mercari Japan (jp.mercari.com) and Yahoo! Auctions Japan (auctions.yahoo.co.jp), prices in yen.
   SOURCES: mark a listing "sold": true when it is sold or no longer available (it still shows the going price). The shopper checks every figure against its listings, so in "listings" give the actual listings behind my_new, my_used and jp_used_yen (up to 3 for each), with the listing title copied exactly as shown, its price and its URL. Base each figure only on listings that are the exact same model and variant. If you include a listing you are not sure is the exact model, set "exact_model": false and leave it out of the figure. Do not report a figure with no listing behind it; use null instead.
4. Read any condition information on the tag or label: the shop's condition grade or rank and what it means on that shop's scale (second-hand chains such as 2nd Street, Hard Off, Book Off, Geo, Sofmap and Surugaya each have their own scale; explain it plainly rather than just saying "good"). If the tag or shelf shows more than one grade (for example separate A and B units of the same item at different prices, or a printed grade legend), list every grade with its price and meaning, and say which one applies to the item photographed if you can tell. Also read every issue, defect or caveat mentioned (e.g. ジャンク, 動作未確認, 通電のみ, 欠品, キズ, 箱なし, 返品不可, 保証なし). Translate each into plain English and rate it: "high" = may not work, sold as-is, no returns or no warranty; "medium" = missing parts, visible damage or heavy wear; "low" = minor cosmetic. List stated positives (e.g. 動作確認済, 美品, 付属品完備) with severity "good". Ignore marketing claims on new-product packaging (e.g. 傷つきにくい means scratch-resistant, not scratched).
5. Check whether it will work properly in Malaysia: 240V 50Hz mains and Type G three-pin plugs (Japan is 100V with Type A two-pin plugs). If they're already shopping in Malaysia, only flag imported units (e.g. a Japanese 100V version or a Japan-only warranty). Cover only what applies to this product:
   - Power: does it accept 240V? Many chargers and adapters are 100-240V and only need a plug adapter; 100V-only appliances (rice cookers, hair dryers, some kitchen and beauty gear) need a step-down transformer.
   - Region: game, Blu-ray or DVD region locks, region-specific online services or apps.
   - Language: Japanese-only menus, firmware or software.
   - Warranty: Japan-only domestic warranty (国内専用, 国内保証) versus international warranty honoured in Malaysia.
   - Other: e.g. forced camera shutter sound on Japanese phones, carrier locks, radio frequency bands, items restricted from import into Malaysia.
   Rate each "ok", "warn" or "bad". Use an empty list when none of this applies (clothes, snacks, books).

Reply with only a JSON object inside a \`\`\`json code block, with exactly these keys:
{
  "product_name": "concise English product name",
  "brand": "brand or null",
  "store_name": "shop or chain name if visible in the photo (e.g. HARD OFF, Bic Camera, Don Quijote), else null",
  "search_query": "best English query to type into Shopee or Carousell: brand + model + variant words",
  "barcode": "the JAN/EAN/UPC number you searched, or null",
  "identified_by": "barcode | product code | label text | appearance",
  "variant": "the exact variant, edition or generation (e.g. Reloaded, OLED, 2nd Gen), or null if there is none",
  "variant_evidence": "where you saw it, e.g. 'box says Reloaded', or null",
  "variant_confidence": "high | medium | low",
  "lookalikes": [
    { "name": "full name of an easily confused variant", "how_to_tell": "how to tell them apart on the box or product", "typical_price_rm": 0 }
  ],
  "search_query_ja": "best Japanese query for Mercari or Yahoo Auctions",
  "price": 12800,
  "currency": "ISO code of the asking price, e.g. JPY, MYR, SGD",
  "shop_country": "ISO country code where they're shopping, e.g. JP, MY",
  "price_tax_included": true,
  "price_note": "short note on which price was read, or null",
  "my_new": { "low": 0, "high": 0, "typical": 0 },
  "my_used": { "low": 0, "high": 0, "typical": 0 },
  "jp_used_yen": { "low": 0, "high": 0, "typical": 0 },
  "cex_my": { "sell_rm": 0, "buy_cash_rm": 0, "buy_voucher_rm": 0, "grade": "CeX grade if shown (A, B, C) or null", "url": "CeX product URL or null" },
  "listings": [
    { "platform": "Shopee | Carousell | Lazada | Mercari JP | Yahoo Auctions | Other", "condition": "new | used", "title": "listing title exactly as shown", "price_rm": 0, "price_yen": 0, "url": "listing URL or null", "exact_model": true, "match_note": "how you know it's the same model, or what differs", "sold": false }
  ],
  "my_compat": [
    { "topic": "Power | Region | Language | Warranty | Other", "status": "ok | warn | bad", "note": "short plain-English explanation" }
  ],
  "condition": {
    "is_used": "true if the tag or item shows it is second-hand (中古, a condition grade, ジャンク), otherwise false",
    "grade": "grade or rank exactly as shown for this item (e.g. B, ランクA, ジャンク), or null",
    "grade_meaning": "what that grade means on this shop's scale, in plain English, or null",
    "grade_options": [
      { "grade": "A", "price_yen": 0, "meaning": "plain-English meaning" }
    ],
    "issues": [
      { "jp": "original Japanese wording", "en": "plain English meaning", "severity": "high | medium | low | good" }
    ],
    "missing": ["items stated as missing, in English"]
  },
  "confidence": "high | medium | low",
  "notes": "one or two sentences on matching caveats (Japan-only variant, voltage, region lock, etc.)"
}
Use price_rm for Malaysian listings and price_yen for Japanese ones. Use null for any price you could not find. Use an empty issues list if the tag mentions no condition information, an empty grade_options list unless more than one grade is shown, and an empty lookalikes list when nothing is easily confused with it.`;
}

// What the tag itself says, as opposed to what the product fetches. When the backend already has
// fresh market prices for a barcode, it only asks Gemini to read these (no search, so it's cheap).
export const TAG_KEYS = ['price', 'currency', 'shop_country', 'price_tax_included', 'price_note', 'store_name', 'condition'];

export function buildTagPrompt({ ocrText, photos = 1, productName }) {
  return `The ${photos > 1 ? `${photos} attached photos show` : 'attached photo shows'} "${productName}" in a shop or an online listing. Read only what the tag, label or listing says.
OCR text:
"""
${ocrText || '(none detected)'}
"""
1. The asking price and its currency: ¥ or 円 = JPY, RM = MYR, S$ = SGD, NT$ = TWD, ₩ = KRW, ฿ = THB, HK$ = HKD, US$ = USD; use the shop's country if no symbol is shown. In Japan, if both tax-inclusive (税込) and tax-exclusive (税抜) prices are shown, use the tax-inclusive one. Use null if no price is visible.
2. Condition information: the shop's grade or rank and what it means on that shop's scale, every grade shown with its price, and every issue, defect or caveat (e.g. ジャンク, 動作未確認, 欠品, キズ, 箱なし, 返品不可) in plain English rated "high" (may not work, as-is, no returns), "medium" (missing parts, damage, heavy wear), "low" (cosmetic) or "good" (stated positives such as 動作確認済).

Reply with only a JSON object inside a \`\`\`json code block:
{
  "price": 12800,
  "currency": "ISO code, e.g. JPY",
  "shop_country": "ISO country code, e.g. JP",
  "price_tax_included": true,
  "price_note": "short note on which price was read, or null",
  "store_name": "shop or chain name if visible, else null",
  "condition": {
    "is_used": false,
    "grade": null,
    "grade_meaning": null,
    "grade_options": [{ "grade": "A", "price_yen": 0, "meaning": "plain-English meaning" }],
    "issues": [{ "jp": "original wording", "en": "plain English", "severity": "high | medium | low | good" }],
    "missing": []
  }
}`;
}
