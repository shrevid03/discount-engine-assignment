# Opptra Discount Engine

[![Tests](https://github.com/shrevid03/discount-engine-assignment/actions/workflows/test.yml/badge.svg)](https://github.com/shrevid03/discount-engine-assignment/actions/workflows/test.yml)

A customer-facing cart pricing engine. Each item gets the offer that saves the customer the most, stackable offers apply on top, and a cart-level offer applies to the total once it crosses a threshold. Rules can be loaded from CSV or written in plain English (parsed by an LLM, then confirmed by a person). Carts can be loaded from CSV or PDF.

**Live app:** https://discount-engine-assignment-iota-nine.vercel.app

**Video walkthrough:** https://drive.google.com/file/d/1Vs3ABmwbNh9OfrpV6xvn9vt8n1UE1-jA/view?usp=sharing (recorded on the live deployment)

## Highlights

- **A pricing conflict in the brief: a discount that raises the price.** Item offers apply first and the cart offer is checked against what remains. A Rs.4,000 cart therefore pays Rs.3,600, but adding "Rs.1 off Nordic Basics" brings the subtotal to Rs.3,999, the cart offer is lost, and the customer pays **Rs.399 more**. The app keeps the brief's algorithm and makes the conflict visible instead: the confirm card turns red ("This discount makes the customer pay Rs.399 more") and its button becomes "Add anyway", and the checkout flags the conflict to the operator if such a rule is active. The **Discount paradox** scenario demonstrates it.
- **Reproduces the brief's expected results:** Rs.5,932 → Rs.5,339, with the cart offer on its own row. Each item has a "Why this price?" breakdown generated from the engine's own calculation steps, so the explanation and the price come from the same computation.
- **Every new rule shows its effect before it goes live:** checkout before and after, which items change and by how much, whether the cart offer is kept, and warnings for rules that never beat an existing offer, overlap or duplicate an existing offer, or push an item past 40% off.
- **LLM output is measured and validated, not trusted.** In the most recent evaluation run, 29 of the 29 completed cases were correct, with **0 unsafe acceptances**. 12 of the 41 cases did not complete because of provider rate limiting and are reported as not run. The evaluation targets the most damaging failure mode: a condition the engine cannot represent being silently dropped ("15% off up to ₹200" becoming an uncapped 15%). Such inputs are returned as unsupported rather than converted into an incorrect rule ([results](evals/results.md)).
- **Incomplete orders are not priced silently.** A PDF with unreadable rows is held for review ("Rows found 5 · readable 2 · could not be read 3"), and the current cart stays in place until someone confirms. Clean PDFs load automatically.
- **A second conflict in the brief:** its stacking order for ITEM-02 gives Rs.629, while its own "biggest saving" principle gives Rs.614 ([details](#proposed-changes-to-the-brief)).
- **Input modes are decoupled from the engine.** Each input mode is one adapter in `src/inputs/` that goes through a shared validator, so adding another input mode requires no changes in `engine/`. 63 tests run in CI.

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add a GEMINI_API_KEY to enable plain-English rules
npm run dev                  # http://localhost:5173
```

Everything except the plain-English rule input works without an API key. `npm test` runs the test suite (63 tests). GitHub Actions runs the tests and the production build on every push.

## Try it

The **Try a scenario** row at the top of the app loads data for each case and calculates immediately:

| Scenario | What it shows |
|---|---|
| Standard checkout | The brief's 6 items and the expected Rs.5,339. Open "Why this price?" on any item. |
| Discount paradox | A cart at exactly Rs.4,000. Parse the pre-filled "Rs.1 off on Nordic Basics" to see the safety check. Uploading `sample-data/rules-paradox.csv` shows the same conflict without the LLM. |
| Plain-English rule | The brief's 20% Natura Casa example, ready to parse, with the full impact preview. |
| PDF with bad rows | The partial-import review: nothing changes until the import is confirmed. |
| Just below the offer | A PDF cart just short of Rs.4,000, with the "Add Rs.X more" hint. |

Manual walkthrough:

1. Click **Load sample data** (or upload `sample-data/rules.csv` and `sample-data/cart.csv`), then **Calculate Discounts**.
2. Enter a rule in plain English (or pick an example), review the parsed fields and the effect on the cart, then **Confirm & add** or **Discard**. Prices update immediately.
3. Upload a cart PDF to replace the cart: `cart.pdf`, `cart-small.pdf` (just below the cart-offer threshold) or `cart-malformed.pdf` (unreadable rows, held for review). They are linked at the top of the page and stored in `sample-data/`.

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

## Architecture

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
tests/                     engine, adapter, and LLM handler tests
```

The engine has no knowledge of where a rule or item came from. All input modes go through the same validators in `models.js`, so a new input mode is a new file in `src/inputs/` with no changes in `engine/`. The engine changes for this assignment were additive: a `cart` scope, `minCartValue`, and `applyCartOffers()`, which runs after the existing item logic.

## Evaluating the LLM parser

A handful of working examples says little about reliability, so `evals/rule-cases.json` defines 41 phrasings, each with its expected result, in three groups:

- **Core (24):** the brief's 4 examples, casual wording ("flat 100 rs off on flipkart stuff", "buy above 5k get 10% off"), ₹ amounts, typos ("flipkrt", "natura casaa"), and inputs that must be refused (two rules in one sentence, no amount, "150% off", a prompt injection).
- **Unsupported and tricky (13):** 8 conditions the engine cannot represent, which must be refused rather than dropped: a cap ("up to ₹200"), an exclusion ("except Natura Casa"), brand and platform combined, a time limit ("only today"), "whichever is higher", a quantity, a single product, and first-time customers. It also includes an injection that dictates the output fields (must be refused), and 4 valid rules that look risky but must still parse correctly: "20% off, but only on Natura Casa", "10% off on Flipkart, not stackable", "10% off above ₹5,000" (read as ≥ Rs.5,000 and shown on the confirm card), and "add another 10% Flipkart discount", which must also flag the existing Flipkart offer (RULE-03) as an overlap or duplicate.
- **Hinglish (4):** for example "Flipkart pe 100 rupaye off sab products par" and "Cart 5000 se zyada ho toh 10% discount". Reported separately so they do not affect the English score.

`npm run eval` sends every case through the deployed parser and the same validation the UI uses, then writes [`evals/results.md`](evals/results.md) with requests completed, exact field match on rule cases, correct refusals, **unsafe acceptances** (a refuse case that produced a rule, the failure that matters most) and latency.

**Most recent run (41 cases): 29 of 29 completed cases correct, 0 unsafe acceptances.** Every unsupported condition that ran was refused (a cap, an exclusion, brand and platform combined, either/or, a single product), and both prompt injections were refused.

**Limitations of this run:** 12 cases did not complete (11 rate-limited, 1 temporary provider unavailability). They include all 4 Hinglish cases, the time-limit, quantity and customer conditions, and the RULE-03 overlap case, so those are untested rather than passed. Latencies in this run include the script's back-off waits; the script has since been changed to time only the final request. The full table is in [`evals/results.md`](evals/results.md), and `npm run eval -- --retry-errors` re-runs the incomplete cases. A 41-case set is a regression check, not a statistical guarantee: model behaviour can change between versions, which is why confirmation and validation stay in place regardless of the score.

## Proposed changes to the brief

The brief invites challenges to its design choices. These are five changes I would propose. The app implements the brief as written, so its results match the expected output.

| The brief's choice | Proposed change | Rationale |
|---|---|---|
| Item offers first, then the cart offer on the remaining total | Check the cart threshold against the cart's value **before** item discounts (or give the customer the better of the two totals) | Under the brief's order, a new item discount can pull a cart below the threshold, so the customer pays more because of a discount: Rs.1 off turns Rs.3,600 into Rs.3,999. This is a pricing-policy decision for Opptra rather than something to change silently in code, so the app keeps the brief's order and **detects** the conflict: the confirm card turns red with an "Add anyway" button, and the checkout shows the conflict to the operator. |
| A stackable rule applies **after** the winning rule (ITEM-02: Rs.150 off, then 10% → Rs.629) | Apply percentage discounts before flat ones (10% off, then Rs.150 → Rs.614) | The brief's stated principle is "always give the customer the biggest saving", and this order saves Rs.15 more with the same two offers. The app keeps the brief's order because it defines the expected results, but the two requirements conflict and the choice should be made deliberately. |
| Stackable rules always stack, with no limit | Add a per-item cap on total discount (for example 40%) | Every new stackable rule compounds. A single plain-English rule ("20% off Natura Casa, stackable") takes ITEM-02 to 41% off. The confirm card warns above 40%, but production campaigns need a margin floor that no combination of offers can break. |
| Confirm every parsed rule | Keep confirmation, and show the rule's effect before confirming (implemented: checkout before and after, each item that changes, cart offer kept or lost) | A field list shows what a rule *is*; the impact preview shows what it *does*. A misread of "Rs.100" as "100%" is obvious when the total collapses. |
| Carts arrive as a PDF table | Use a structured export or an order-ID lookup; for third-party PDFs, use LLM extraction followed by the same validation and confirm step | Parsing a rendered document depends on its layout. The parser handles the variations tested (wrapped cells, ₹ prices, total rows, browser-printed PDFs), but new layouts will introduce new edge cases. |

## Decisions and trade-offs

**Cart offer**
- Evaluated on the sum of final item prices (after item discounts) and shown as its own row rather than distributed across items. The row appears only when the cart qualifies.
- The threshold is inclusive (`total ≥ min`), matching RULE-04. A cart Rs.1 below the threshold gets no offer; the summary shows "Add Rs.X more to unlock Cart offer: 10% off" instead, which helps the customer and makes the near-miss case visible.
- If several cart rules qualify, the item logic applies: the largest non-stackable saving wins, and stackable cart rules apply on top.
- A cart rule must state its threshold. A blank `min_cart_value` is rejected in every input mode rather than defaulting to "every cart qualifies". An offer for every cart requires an explicit `0` (the plain-English path asks for a threshold instead).
- When item offers push a cart below a threshold it would otherwise meet, the checkout shows an operator note with what the customer would have paid without them (see the paradox above).

**Plain-English rules (LLM)**
- **The API key stays on the server.** A static deployment would have to expose the key to every visitor, so the LLM call runs in a small serverless function (`/api/parse-rule`) while the rest of the app remains static. This is the only backend component, which the brief allows.
- **Provider:** Gemini (`gemini-2.5-flash`, configurable with `GEMINI_MODEL`), chosen for low cost and latency at prototype scale. The provider integration is contained in `server/parseRule.js`, so changing providers is isolated to that file.
- The model is constrained to a JSON schema (`responseJsonSchema`, temperature 0), and its output is still treated as untrusted: the browser runs it through the same `validateRule()` the CSV path uses. A response that reports success but fails validation (no value, a 150% discount, an unknown scope) is shown as "Need a bit more detail" and is not added.
- Ambiguous input ("Give a discount for big orders") returns `status: "ambiguous"` with a one-line clarification of what to add. The prompt instructs the model not to invent a value, threshold or name; validation and the confirm step cover cases where it does.
- The confirm card shows every parsed field and warns about rules that will have no effect (for example, a brand not in the cart) or that duplicate an existing rule. **Confirmation is kept deliberately**: a single misread of "Rs.100" as "100%" changes every price, so a human check before a rule goes live is worth one extra click.
- Brand and platform names already loaded are sent as context, so "flipkart" or "natura casa" are stored with the exact spelling the matcher needs.
- "More than Rs.5,000" is read as a Rs.5,000 threshold with the same inclusive `≥` as RULE-04. Treating it as strictly greater would mean one cart rule uses `>` and another uses `≥`, a difference the customer cannot see. The confirm card shows the threshold so the user can correct it.
- **Conditions the engine cannot represent are refused, not dropped.** This depends on the model recognising the condition, so it is measured by the evaluation rather than assumed. Caps, exclusions, brand and platform combinations, dates, quantities, single products, customer conditions and either/or offers are returned as `status: "unsupported"` and shown as "The engine can't apply this offer as written". Turning "15% off up to ₹200" into an uncapped 15% is worse than invalid JSON, because the result looks correct.
- **The public endpoint is protected.** Requests are limited to 8 per minute per client and 60 per minute per instance (`server/rateLimit.js`, which returns 429 with `Retry-After`). Request bodies over 8 KB are rejected, the name lists sent as context are capped, and the upstream call times out after 25 seconds. The limiter is in memory and therefore per serverless instance, which is sufficient to stop a single client exhausting the provider quota; production would use a shared store or the host's firewall rules.
- **Provider availability and quota.** LLM APIs return transient "busy" errors and enforce per-model quotas, so the call is designed to degrade gracefully. A busy or timed-out request is retried once. If the primary model is busy, out of quota, or unavailable to the key, the call falls back to a secondary model (`gemini-flash-latest`, configurable with `GEMINI_FALLBACK_MODEL`). If neither model is available to the key (providers rename and retire models), the server queries the provider for an available Flash model and uses the newest stable one. Every fallback response goes through the same validation and confirm step.
- Failures (no key configured, rate limit, timeout, refusal, truncated or non-JSON output, network errors) are handled and shown as a plain message in the UI, which also points to CSV upload as an alternative way to add rules. They leave the active rules unchanged.

**PDF cart**
- Parsed in the browser with pdf.js, so no upload server is needed. Columns are located from the positions of the header words (Product, Brand, Platform, Base Price), so names with spaces ("Cushion Cover", "Amazon India") are not split. If a row is stored as a single text run, the parser falls back to splitting on wide gaps, tabs or pipes. Names that wrap onto two or three lines within a cell are rejoined, and `₹`/`Rs.` prices, right-aligned price columns and total rows are handled. In addition to the sample PDFs, the tests include browser-printed PDFs (`tests/fixtures/`) to avoid tuning the parser to a single generator.
- **Malformed rows are reported by row with the reason** ("Row 2 skipped: missing Base Price", "Row 3 skipped: base price must be a positive rupee amount (got "Rs.TBD")"). If any row fails, the import is **held for review**: "Rows found 5 · readable 2 · could not be read 3", with **Import 2 readable items** or **Keep current cart**. Loading only the readable rows immediately would show a checkout total for an incomplete order, which understates the real total. A clean PDF replaces the cart and re-runs the engine automatically, as the brief requires.
- If no row can be read (wrong file, scanned image, missing header), the current cart is kept and the user is told why, rather than replacing the cart with an empty one.
- Item IDs are generated (ITEM-01, ITEM-02, …) because the PDF format does not include them.
- For production, see the PDF row under [Proposed changes](#proposed-changes-to-the-brief): a structured export or order-ID lookup is more reliable than parsing a rendered document.

**Engine details**
- Rounding is applied per discount step, which reproduces the brief's numbers (ITEM-02: 849 − 150 = 699, then 699 × 0.9 = 629). Amounts are whole rupees, capped at Rs.1 crore, and rounded at each step, which keeps floating-point error from accumulating across steps.
- **Ties:** when two non-stackable offers save the same amount, the first one listed wins (deterministic), and the explanation reads "same saving as …" rather than "better deal than".
- Stackable offers apply in the order listed. With one stackable offer per item (as in the sample data) the order does not matter; with several, a percentage-then-flat order would save the customer more, which is the same question as the ITEM-02 row above.
- A flat discount cannot take a price below zero. A 100% discount is rejected, because giving an item away is a different business decision from a promotion.
- An empty rule set is valid: the cart still calculates, and every item shows its base price with a no-offer reason.
- Rule and item IDs must be unique; a later row with a duplicate ID is skipped with a reason.
- After the first **Calculate Discounts**, results stay live: adding or removing a rule, or loading a new cart, re-runs the engine immediately.
- The original `sample-data/rules.csv` did not include RULE-04 or the `min_cart_value` column, so it was updated to match the brief. The 6-column format still loads.

## Deploying (Vercel)

1. Import the repo in Vercel. It detects Vite (`npm run build`, output `dist/`) and the `api/` function automatically.
2. Add `GEMINI_API_KEY` (from Google AI Studio) under Project → Settings → Environment Variables. `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` are optional.
3. Deploy. This project is deployed at https://discount-engine-assignment-iota-nine.vercel.app

On a static-only host (Netlify drop, GitHub Pages) everything works except plain-English rules, which show "not configured on this deployment".
