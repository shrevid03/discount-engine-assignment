# Opptra Discount Engine

[![Tests](https://github.com/shrevid03/discount-engine-assignment/actions/workflows/test.yml/badge.svg)](https://github.com/shrevid03/discount-engine-assignment/actions/workflows/test.yml)

A customer-facing cart pricing engine: each item gets the offer that saves the customer the most, stackable offers go on top, and a cart-level offer applies to the total once it crosses a threshold. Rules can come from a CSV or from plain English (parsed by an LLM, with a confirm step). Carts can come from a CSV or a PDF.

**Live app:** https://discount-engine-assignment-iota-nine.vercel.app

## Highlights

- **Found a pricing trap in the brief: a discount that raises the price.** Item offers apply first and the cart offer is checked on what's left, so a cart sitting at Rs.4,000 pays Rs.3,600, but add "Rs.1 off Nordic Basics" and it drops to Rs.3,999, loses the cart offer and pays **Rs.399 more**. The app doesn't silently change the brief's algorithm. It catches this before a rule goes live (the confirm card turns red: "This discount makes the customer pay Rs.399 more", button becomes "Add anyway"), and flags it on the checkout if it happens anyway. Click **Discount paradox** at the top of the app to see it.
- **Matches the brief exactly:** Rs.5,932 → Rs.5,339, with the cart offer on its own row. Every item has a "Why this price?" breakdown built from the engine's own calculation steps, not a second explanation that could drift.
- **Every rule shows its effect before it goes live:** checkout before and after, which items change and by how much, whether the cart offer survives, and warnings for rules that never beat an existing offer, overlap an existing offer, or push an item past 40% off.
- **The LLM is measured, not trusted.** The eval covers casual wording, typos, ₹ amounts, Hinglish, and a "tricky" set, mostly conditions the engine can't represent, built to catch the dangerous failure: a condition the engine can't represent being quietly dropped ("15% off up to ₹200" becoming an uncapped 15%). Those now come back as "the engine can't apply this offer as written" instead of a wrong rule. The report counts **unsafe acceptances** separately from accuracy ([results](evals/results.md)).
- **Incomplete orders aren't priced silently:** a PDF with bad rows is held for review ("Rows found 5 · readable 2 · could not be read 3"), and the current cart stays until someone confirms. Clean PDFs still load automatically.
- **Found a second conflict in the brief:** its stacking order for ITEM-02 gives Rs.629, but its own "biggest saving" principle gives Rs.614 ([details](#where-id-do-it-differently)).
- **Inputs adapt to the engine:** every input mode is one file in `src/inputs/` going through one validator. A fourth mode touches nothing in `engine/`. 59 tests run in CI.

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add a free GEMINI_API_KEY to enable plain-English rules
npm run dev                  # http://localhost:5173
```

Everything except the plain-English rule box works without a key. `npm test` runs the test suite (59 tests). GitHub Actions runs the tests and the build on every push.

## Try it

The quickest way is the **Try a scenario** row at the top of the app. Each button loads its data and calculates straight away:

| Scenario | What it shows |
|---|---|
| Standard checkout | The brief's 6 items and the expected Rs.5,339. Open "Why this price?" on any item. |
| Discount paradox | A cart at exactly Rs.4,000. Click **Parse rule** on the pre-filled "Rs.1 off on Nordic Basics" to see the safety check. |
| Plain-English rule | The brief's 20% Natura Casa example, ready to parse, with the full impact preview. |
| PDF with bad rows | The partial-import review: nothing changes until you confirm. |
| Just below the offer | A PDF cart just short of Rs.4,000, with the "Add Rs.X more" hint. |

Or by hand:

1. Click **Load sample data** (or upload `sample-data/rules.csv` and `sample-data/cart.csv`), then click **Calculate Discounts**.
2. Type a rule in plain English (or click an example), check the parsed fields and the effect on the cart, then **Confirm & add** or **Discard**. Prices update immediately.
3. Upload a cart PDF to replace the cart: `cart.pdf`, `cart-small.pdf` (just below the cart-offer threshold) or `cart-malformed.pdf` (bad rows, held for review). They're linked at the top of the page and in `sample-data/`.

Expected results for the sample data:

| Item | Base | Final | Offer applied |
|---|---|---|---|
| ITEM-01 | Rs.1,299 | Rs.1,104 | Platform offer: 15% off (better deal than Brand offer: Rs.150 off) |
| ITEM-02 | Rs.849 | Rs.629 | Brand offer: Rs.150 off + Platform offer: 10% off |
| ITEM-03 | Rs.599 | Rs.509 | Platform offer: 15% off |
| ITEM-04 | Rs.2,499 | Rs.2,499 | No offers available, no current offer covers LivSpace Pro or Noon |
| ITEM-05 | Rs.449 | Rs.382 | Platform offer: 15% off |
| ITEM-06 | Rs.899 | Rs.809 | Platform offer: 10% off |
| | | **Rs.5,932** | Cart total before offer |
| | | **−Rs.593** | Cart offer: 10% off, Rs.593 saved |
| | | **Rs.5,339** | Final cart total |

## How it's built

```
src/
  engine/
    discountEngine.js      pure pricing logic: item rules, then cart rules (calculateCheckout),
                           plus simulateRule (impact preview) and findCartOfferConflict (the paradox)
    models.js              the engine's input contract: validateRule / validateCartItem
  inputs/                  adapters, one per input mode; each returns DiscountRule[] or CartItem[]
    csv.js                 CSV → rules / cart
    pdfCart.js             PDF → cart (pdf.js, runs in the browser)
    naturalLanguageRule.js plain English → draft rule (calls /api/parse-rule, then validates)
  components/              UI only (RuleComposer, CartSummary, FileUploader, DataTable, ErrorBanner)
server/parseRule.js        the LLM call (Gemini, JSON-schema output)
server/rateLimit.js        per-client and per-instance limits for the public endpoint
api/parse-rule.js          Vercel function wrapping server/parseRule.js
tests/                     engine, adapters, and LLM handler tests
```

The engine never knows where a rule or item came from. Every input mode goes through the same validators in `models.js`, so **a third input mode is a new file in `src/inputs/` and nothing in `engine/` changes**. The engine change for this assignment was additive: a `cart` scope, `minCartValue`, and `applyCartOffers()` run after the existing item logic.

## How reliable is the LLM parsing?

Three working examples don't show much, so `evals/rule-cases.json` holds 41 phrasings with the right answer for each, in three groups:

- **Core (24):** the brief's 4 examples, casual wording ("flat 100 rs off on flipkart stuff", "buy above 5k get 10% off"), ₹ amounts, typos ("flipkrt", "natura casaa"), and inputs that should be refused (two rules at once, no amount, "150% off", a prompt injection).
- **Unsupported and tricky (13):** 8 conditions the engine can't represent, which must be refused rather than dropped: a cap ("up to ₹200"), an exclusion ("except Natura Casa"), brand + platform together, a time limit ("only today"), "whichever is higher", a quantity, a single product, first-time customers. Plus an injection that dictates the output fields (refuse), and 4 valid rules that look risky but must still parse correctly: "20% off, but only on Natura Casa", "10% off on Flipkart, not stackable", "10% off above ₹5,000" (read as ≥ Rs.5,000, shown on the confirm card), and "add another 10% Flipkart discount", which must also warn that Flipkart already has an offer.
- **Hinglish (4):** "Flipkart pe 100 rupaye off sab products par", "Cart 5000 se zyada ho toh 10% discount", and so on. Kept separate so it doesn't inflate the English score.

`npm run eval` runs every case through the live parser and the same validation the UI uses, then writes [`evals/results.md`](evals/results.md) with: requests completed, exact field match on rule cases, correct refusals, **unsafe acceptances** (a refuse case that produced a rule, the failure that matters most) and latency.

**Last run: 23 of 23 answered core cases correct** (1 hit Gemini's free-tier rate limit). That run was before the prompt learned to refuse unsupported conditions and before the 17 new cases were added; results.md is replaced on the next run.

## Where I'd do it differently

The brief invites pushing back on its design choices. These are the four I'd raise. The app follows the brief as written, so its numbers match the expected results.

| The brief's choice | What I'd propose | Why |
|---|---|---|
| Item offers first, then the cart offer on what's left | Check the cart threshold against the cart's value **before** item discounts (or give the customer the better of the two totals) | Under the brief's order, a new item discount can pull a cart under the threshold, so the customer pays more for getting a discount: Rs.1 off turns Rs.3,600 into Rs.3,999. That's a pricing-policy decision for Opptra, not one to make silently in code, so the app keeps the brief's order and **detects** it: the confirm card turns red and its button becomes "Add anyway", and the checkout shows the conflict to the operator. |
| A stackable rule applies **after** the winning rule (ITEM-02: Rs.150 off, then 10% → Rs.629) | Apply percentage discounts before flat ones (10% off, then Rs.150 → Rs.614) | The brief's own principle is "always give the customer the biggest saving", and this order saves Rs.15 more on the same two offers. I kept the brief's order because it defines the expected results, but the two rules conflict, and someone should choose deliberately. |
| Stackable rules always stack, with no limit | Add a per-item cap on total discount (for example 40%) | Every new stackable rule compounds. One plain-English rule ("20% off Natura Casa, stackable") takes ITEM-02 to 41% off. The confirm card now warns above 40%, but real campaigns need a margin floor that no combination of offers can break. |
| Confirm every parsed rule | Keep it, and show its effect before confirming (built: checkout before/after, each item that changes, cart offer kept or lost) | A field list says what the rule *is*; the impact preview says what it *does*. A misread "Rs.100" as "100%" is obvious when the total collapses. |
| Carts arrive as a PDF table | Use a structured export or an order-ID lookup. For outside PDFs, use LLM extraction followed by the same validation and confirm step | Parsing a rendered document depends on its layout. I handled the cases I could find (wrapped cells, ₹ prices, total rows, browser-printed PDFs), but the next layout will find a new edge. |

## Decisions and tradeoffs

**Cart offer**
- Evaluated on the sum of final item prices, after item discounts, and shown as its own row, never spread across items. The row only appears when the cart qualifies.
- The threshold is inclusive (`total ≥ min`), matching RULE-04. A cart Rs.1 below gets no offer; instead the summary shows "Add Rs.X more to unlock Cart offer: 10% off". That's useful to a customer, and it makes the near-miss case visible instead of silent.
- If several cart rules qualify, the same logic as items applies: the biggest non-stackable saving wins, stackable cart rules go on top.
- A cart rule must state its threshold. A blank `min_cart_value` is rejected in every input mode, rather than quietly becoming "every cart qualifies". A cart offer for every cart is allowed only when someone writes `0` on purpose (the plain-English path asks for a threshold instead).
- When item offers push a cart below a threshold it would otherwise meet, the checkout shows an operator note with what the customer would have paid without them (see the paradox above).

**Plain-English rules (LLM)**
- **The API key stays on the server.** A static deploy would have to ship the key to every visitor's browser, so the LLM call runs in a small serverless function (`/api/parse-rule`). The rest of the app is still static. This is the one place I added a backend, and the brief allows it.
- **Gemini** (`gemini-2.5-flash`, changeable with `GEMINI_MODEL`) because it has a free API tier, which is enough for a prototype. The provider is isolated in `server/parseRule.js`; swapping LLMs touches only that file.
- The model is constrained to a JSON schema (`responseJsonSchema`, temperature 0), and its answer is still treated as untrusted: the browser runs it through the same `validateRule()` the CSV uses. A response that claims to be fine but fails validation (no value, a 150% discount, unknown scope) is shown as "Need a bit more detail", never added.
- Ambiguous input ("Give a discount for big orders") comes back as `status: "ambiguous"` with a one-line clarification telling the user what to add. The prompt tells the model never to invent a value, threshold or name.
- The confirm card shows every parsed field and warns about rules that won't do anything (for example, a brand that isn't in the cart) or that duplicate an existing rule. **I kept the confirmation step**: one misread "Rs.100" as "100%" changes every price, so a human check before a rule goes live is worth one extra click.
- Brand and platform names already loaded are sent as context, so "flipkart" or "natura casa" are stored with the exact spelling the matcher needs.
- "More than Rs.5,000" is read as a Rs.5,000 threshold with the same inclusive `≥` as RULE-04. Treating it as strictly greater would mean one cart rule using `>` and another using `≥`, which the customer can't see. The confirm card shows the threshold so the user can correct it.
- **Conditions the engine can't represent are refused, not dropped.** This depends on the model spotting the condition, so it is measured by the eval rather than assumed. Caps, exclusions, brand + platform combinations, dates, quantities, single products, customer conditions and either/or offers come back as `status: "unsupported"`, shown as "The engine can't apply this offer as written". Turning "15% off up to ₹200" into an uncapped 15% is worse than invalid JSON, because it looks right.
- **The public endpoint is protected.** The key is server-side, and the endpoint itself is limited: 8 requests a minute per client and 60 per instance (`server/rateLimit.js`, answers 429 with `Retry-After`), request bodies over 8 KB are refused, the name lists sent as context are capped, and the Gemini call times out after 15 seconds. The limiter lives in memory, so it's per serverless instance: enough to stop one script draining the free quota. Production would use a shared store or the host's firewall rules.
- Failures (no key configured, rate limit, timeout, refusal, truncated or non-JSON output, network down) each produce a plain message in the UI, which also points to the CSV upload as a way to keep adding rules. None of them crash the page or touch the active rules.

**PDF cart**
- Parsed in the browser with pdf.js, so no upload server is needed. Columns are found from where the header words (Product, Brand, Platform, Base Price) sit on the page, so names with spaces ("Cushion Cover", "Amazon India") don't get split. If a row is stored as one text run, it falls back to splitting on wide gaps, tabs or pipes. Names that wrap onto two or three lines inside a cell are joined back together, and `₹`/`Rs.` prices, right-aligned price columns and Total rows are handled. Besides the sample PDFs, the tests include PDFs printed from a browser (`tests/fixtures/`), so it's not only tuned to one generator.
- **Malformed rows are listed by row with the reason** ("Row 2 skipped: missing Base Price", "Row 3 skipped: base price must be a positive rupee amount (got "Rs.TBD")"). If any row fails, the import is **held for review**: "Rows found 5 · readable 2 · could not be read 3", with **Import 2 readable items** or **Keep current cart**. Loading the good rows straight away would show a checkout total for an incomplete order, which looks cheaper than the real one. A clean PDF still replaces the cart and re-runs the engine automatically, as the brief asks.
- If no row can be read (wrong file, scanned image, missing header), **the current cart is kept** and the user is told why, rather than replacing the cart with nothing.
- Item IDs are generated (ITEM-01, ITEM-02, …) because the PDF format has none.
- Alternative I'd propose for production: the PDF assumption is fragile. If carts come from Opptra's own systems, a JSON/CSV export (or an order ID lookup) is more reliable than parsing a rendered document. For PDFs from outside, an LLM extraction pass with the same validation and confirm step would handle varied layouts better than column positions.

**Engine details**
- Rounding happens per discount step, which reproduces the brief's numbers exactly (ITEM-02: 849 − 150 = 699, then 699 × 0.9 = 629). Amounts are whole rupees and capped at Rs.1 crore, so floating-point error can't creep in.
- **Ties:** when two non-stackable offers save exactly the same, the one listed first wins (deterministic), and the reason says "same saving as …", never "better deal than".
- Stackable offers apply in the order they're listed. With one stackable per item (as in the sample) the order doesn't matter; with several, a percentage-then-flat order would save the customer more, which is the same question as the ITEM-02 row above.
- A flat discount can't take a price below zero. A 100% discount is rejected: a free item is a different business decision from a promotion.
- No rules is a valid state: the cart still calculates, and every item shows its base price with a no-offer reason.
- Rule and item IDs must be unique; a second row with the same ID is skipped with a reason.
- After the first **Calculate Discounts**, results stay live: adding or removing a rule, or loading a new cart, re-runs the engine immediately.
- The repo's original `sample-data/rules.csv` didn't include RULE-04 or the `min_cart_value` column. I updated it to match the brief. The 6-column format still loads.

## Deploying (Vercel)

1. Import the repo in Vercel. It detects Vite (`npm run build`, output `dist/`) and the `api/` function automatically.
2. Add `GEMINI_API_KEY` (free from Google AI Studio) under Project → Settings → Environment Variables.
3. Deploy. This project is live at https://discount-engine-assignment-iota-nine.vercel.app

On a pure static host (Netlify drop, GitHub Pages) everything works except plain-English rules, which show "not configured on this deployment".
