# Opptra Discount Engine

A customer-facing cart pricing engine: each item gets the offer that saves the customer the most, stackable offers go on top, and a cart-level offer applies to the total once it crosses a threshold. Rules can come from a CSV or from plain English (parsed by an LLM, with a confirm step). Carts can come from a CSV or a PDF.

**Live app:** _LIVE_URL_ (add after deploying)

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add ANTHROPIC_API_KEY to enable plain-English rules
npm run dev                  # http://localhost:5173
```

Everything except the plain-English rule box works without a key. `npm test` runs the test suite (36 tests).

## Try it

1. Upload `sample-data/rules.csv` and `sample-data/cart.csv`, then click **Calculate Discounts**.
2. Type a rule in plain English (or click an example), check the parsed fields, then **Confirm & add** or **Discard**. Prices update immediately.
3. Upload `sample-data/cart.pdf` to replace the cart from a PDF. Also try `cart-small.pdf` (just below the cart-offer threshold) and `cart-malformed.pdf` (bad rows are skipped with a reason).

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
    discountEngine.js      pure pricing logic: item rules, then cart rules (calculateCheckout)
    models.js              the engine's input contract: validateRule / validateCartItem
  inputs/                  adapters, one per input mode; each returns DiscountRule[] or CartItem[]
    csv.js                 CSV → rules / cart
    pdfCart.js             PDF → cart (pdf.js, runs in the browser)
    naturalLanguageRule.js plain English → draft rule (calls /api/parse-rule, then validates)
  components/              UI only (RuleComposer, CartSummary, FileUploader, DataTable, ErrorBanner)
server/parseRule.js        the LLM call (Claude, structured JSON output)
api/parse-rule.js          Vercel function wrapping server/parseRule.js
tests/                     engine, adapters, and LLM handler tests
```

The engine never knows where a rule or item came from. Every input mode goes through the same validators in `models.js`, so **a third input mode is a new file in `src/inputs/` and nothing in `engine/` changes**. The engine change for this assignment was additive: a `cart` scope, `minCartValue`, and `applyCartOffers()` run after the existing item logic.

## Decisions and tradeoffs

**Cart offer**
- Evaluated on the sum of final item prices, after item discounts, and shown as its own row, never spread across items. The row only appears when the cart qualifies.
- The threshold is inclusive (`total ≥ min`), matching RULE-04. A cart Rs.1 below gets no offer; instead the summary shows "Add Rs.X more to unlock Cart offer: 10% off". That's useful to a customer, and it makes the near-miss case visible instead of silent.
- If several cart rules qualify, the same logic as items applies: the biggest non-stackable saving wins, stackable cart rules go on top.

**Plain-English rules (LLM)**
- **The API key stays on the server.** A static deploy would have to ship the key to every visitor's browser, so the LLM call runs in a small serverless function (`/api/parse-rule`). The rest of the app is still static. This is the one place I added a backend, and the brief allows it.
- The model is constrained to a JSON schema (structured outputs), and its answer is still treated as untrusted: the browser runs it through the same `validateRule()` the CSV uses. A response that claims to be fine but fails validation (no value, a 150% discount, unknown scope) is shown as "Need a bit more detail", never added.
- Ambiguous input ("Give a discount for big orders") comes back as `status: "ambiguous"` with a one-line clarification telling the user what to add. The prompt tells the model never to invent a value, threshold or name.
- The confirm card shows every parsed field and warns about rules that won't do anything (for example, a brand that isn't in the cart) or that duplicate an existing rule. **I kept the confirmation step**: one misread "Rs.100" as "100%" changes every price, so a human check before a rule goes live is worth one extra click.
- Brand and platform names already loaded are sent as context, so "flipkart" or "natura casa" are stored with the exact spelling the matcher needs.
- "More than Rs.5,000" is read as a Rs.5,000 threshold with the same inclusive `≥` as RULE-04. Treating it as strictly greater would mean one cart rule using `>` and another using `≥`, which the customer can't see. The confirm card shows the threshold so the user can correct it.
- Failures (no key configured, rate limit, refusal, truncated or non-JSON output, network down) each produce a plain message in the UI. None of them crash the page or touch the active rules.

**PDF cart**
- Parsed in the browser with pdf.js, so no upload server is needed. Columns are found from where the header words (Product, Brand, Platform, Base Price) sit on the page, so names with spaces ("Cushion Cover", "Amazon India") don't get split. If a row is stored as one text run, it falls back to splitting on wide gaps, tabs or pipes.
- **Malformed rows are skipped and listed by row with the reason** ("Row 2 skipped: missing Base Price", "Row 3 skipped: base price must be a positive rupee amount (got "Rs.TBD")"). The good rows still load. Dropping a whole order because one line is bad seemed worse for the customer than a partial cart with a clear warning.
- If no row can be read (wrong file, scanned image, missing header), **the current cart is kept** and the user is told why, rather than replacing the cart with nothing.
- Item IDs are generated (ITEM-01, ITEM-02, …) because the PDF format has none.
- Alternative I'd propose for production: the PDF assumption is fragile. If carts come from Opptra's own systems, a JSON/CSV export (or an order ID lookup) is more reliable than parsing a rendered document. For PDFs from outside, an LLM extraction pass with the same validation and confirm step would handle varied layouts better than column positions.

**Engine details**
- Rounding happens per discount step, which reproduces the brief's numbers exactly (ITEM-02: 849 − 150 = 699, then 699 × 0.9 = 629).
- A flat discount can't take a price below zero.
- After the first **Calculate Discounts**, results stay live: adding or removing a rule, or loading a new cart, re-runs the engine immediately.
- The repo's original `sample-data/rules.csv` didn't include RULE-04 or the `min_cart_value` column. I updated it to match the brief. The 6-column format still loads.

## Deploying (Vercel)

1. Import the repo in Vercel. It detects Vite (`npm run build`, output `dist/`) and the `api/` function automatically.
2. Add `ANTHROPIC_API_KEY` under Project → Settings → Environment Variables.
3. Deploy, then put the URL at the top of this README.

On a pure static host (Netlify drop, GitHub Pages) everything works except plain-English rules, which show "not configured on this deployment".
