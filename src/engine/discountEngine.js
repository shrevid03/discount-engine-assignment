/**
 * discountEngine.js
 *
 * Pure discount calculation logic. No UI, no side effects.
 * All functions take plain objects and return plain objects.
 *
 * Data shapes:
 *
 * DiscountRule {
 *   ruleId:       string       — e.g. "RULE-01"
 *   scope:        "brand" | "platform" | "cart"
 *   appliesTo:    string       — e.g. "Natura Casa", "Amazon India" ("" for cart rules)
 *   type:         "percentage" | "flat"
 *   value:        number       — percentage as integer (15 = 15%), flat in rupees
 *   stackable:    boolean
 *   minCartValue: number       — cart rules only: minimum cart total to qualify
 * }
 *
 * Validation of these shapes lives in models.js. The engine assumes valid input.
 *
 * CartItem {
 *   itemId:    string       — e.g. "ITEM-01"
 *   product:   string
 *   brand:     string
 *   platform:  string
 *   basePrice: number       — in rupees
 * }
 *
 * DiscountResult {
 *   itemId:        string
 *   product:       string
 *   brand:         string
 *   platform:      string
 *   basePrice:     number
 *   finalPrice:    number
 *   totalDiscount: number
 *   appliedRules:  string[]
 *   skippedRules:  string[]
 *   reasoning:     string   — customer-readable explanation
 * }
 */

/**
 * Returns true if the rule applies to this cart item.
 */
export function ruleMatchesItem(item, rule) {
  const normalise = (s) => s.trim().toLowerCase()
  if (rule.scope === 'brand') {
    return normalise(item.brand) === normalise(rule.appliesTo)
  }
  if (rule.scope === 'platform') {
    return normalise(item.platform) === normalise(rule.appliesTo)
  }
  return false
}

/**
 * Calculates the rupee discount a rule gives on a given price.
 * Uses the provided price, not the original base price — important for stacking.
 */
export function calculateDiscountAmount(price, rule) {
  if (rule.type === 'percentage') {
    return Math.round(price * rule.value / 100)
  }
  if (rule.type === 'flat') {
    // A flat discount can never take the price below zero.
    return Math.min(rule.value, price)
  }
  return 0
}

export function formatRupees(n) {
  return `Rs.${Math.round(n).toLocaleString('en-IN')}`
}

/**
 * Builds the customer-facing reasoning string for an applied rule.
 */
export function ruleToReasoning(rule) {
  const scopeLabel = { brand: 'Brand', platform: 'Platform', cart: 'Cart' }[rule.scope] ?? 'Special'
  if (rule.type === 'percentage') {
    return `${scopeLabel} offer: ${rule.value}% off`
  }
  if (rule.type === 'flat') {
    return `${scopeLabel} offer: ${formatRupees(rule.value)} off`
  }
  return `${scopeLabel} offer applied`
}

/**
 * Applies the active discount rules to a single cart item.
 * Returns a DiscountResult.
 *
 * Logic:
 *   1. Find all rules that match this item.
 *   2. Among non-stackable rules, pick the one giving the largest discount.
 *   3. Apply any stackable rules on top of that price.
 *   4. Build the reasoning string from what was applied.
 */
export function applyDiscounts(item, rules) {
  const matchingRules = rules.filter((r) => ruleMatchesItem(item, r))

  // No rules match — return base price with explanation
  if (matchingRules.length === 0) {
    return {
      itemId: item.itemId,
      product: item.product,
      brand: item.brand,
      platform: item.platform,
      basePrice: item.basePrice,
      finalPrice: item.basePrice,
      totalDiscount: 0,
      appliedRules: [],
      skippedRules: [],
      reasoning: `No offers available — no current offer covers ${item.brand} or ${item.platform}`,
      steps: [],
    }
  }

  const nonStackable = matchingRules.filter((r) => !r.stackable)
  const stackable = matchingRules.filter((r) => r.stackable)

  // Pick the non-stackable rule that gives the largest saving
  let winner = null
  let skipped = []

  if (nonStackable.length > 0) {
    const sorted = [...nonStackable].sort(
      (a, b) =>
        calculateDiscountAmount(item.basePrice, b) -
        calculateDiscountAmount(item.basePrice, a)
    )
    winner = sorted[0]
    skipped = sorted.slice(1)
  }

  // Apply winner first, then stack on top. `steps` records every matching rule
  // and what it did, so the UI can show a "why this price?" breakdown that comes
  // from the real calculation, not a separate explanation.
  let price = item.basePrice
  const appliedRules = []
  const reasoningParts = []
  const steps = []

  if (winner) {
    const winnerSaving = calculateDiscountAmount(price, winner)
    steps.push({ ruleId: winner.ruleId, label: ruleToReasoning(winner), status: 'best', saving: winnerSaving, from: price, to: price - winnerSaving })
    price -= winnerSaving
    for (const r of skipped) {
      steps.push({ ruleId: r.ruleId, label: ruleToReasoning(r), status: 'not used', saving: calculateDiscountAmount(item.basePrice, r) })
    }
    appliedRules.push(winner.ruleId)
    // Tell the customer why they got this offer and not the other one. On a tie
    // neither is "better": the sort is stable, so the offer listed first wins,
    // and the reason says the saving is the same.
    const tied = skipped.filter((r) => calculateDiscountAmount(item.basePrice, r) === winnerSaving)
    const beaten = skipped.filter((r) => !tied.includes(r))
    const notes = [
      ...(tied.length ? [`same saving as ${tied.map(ruleToReasoning).join(', ')}`] : []),
      ...(beaten.length ? [`better deal than ${beaten.map(ruleToReasoning).join(', ')}`] : []),
    ]
    reasoningParts.push(notes.length ? `${ruleToReasoning(winner)} (${notes.join('; ')})` : ruleToReasoning(winner))
  }

  for (const rule of stackable) {
    const saving = calculateDiscountAmount(price, rule)
    steps.push({ ruleId: rule.ruleId, label: ruleToReasoning(rule), status: 'stacked', saving, from: price, to: price - saving })
    price -= saving
    appliedRules.push(rule.ruleId)
    reasoningParts.push(ruleToReasoning(rule))
  }

  const finalPrice = Math.round(price)

  return {
    itemId: item.itemId,
    product: item.product,
    brand: item.brand,
    platform: item.platform,
    basePrice: item.basePrice,
    finalPrice,
    totalDiscount: item.basePrice - finalPrice,
    appliedRules,
    skippedRules: skipped.map((r) => r.ruleId),
    reasoning: reasoningParts.join(' + '),
    steps,
  }
}

/**
 * Runs applyDiscounts across every item in the cart.
 * Returns an array of DiscountResult objects.
 */
export function processCart(cartItems, rules) {
  return cartItems.map((item) => applyDiscounts(item, rules))
}

/**
 * Sums the final prices across all results.
 */
export function cartTotal(results) {
  return results.reduce((sum, r) => sum + r.finalPrice, 0)
}

/**
 * Applies cart-level rules to the cart total after item-level discounts.
 *
 * Same selection logic as items: among qualifying non-stackable cart rules
 * the largest rupee saving wins; qualifying stackable cart rules apply on top.
 * A rule qualifies when subtotal >= minCartValue.
 *
 * Returns {
 *   subtotal, total,
 *   cartOffer: null | { appliedRules, label, saving },
 *   unmetOffers: [{ ruleId, label, minCartValue, shortBy }]  — so the UI can
 *                say "add Rs.68 more to get 10% off" when just below a threshold
 * }
 */
export function applyCartOffers(subtotal, rules) {
  const cartRules = rules.filter((r) => r.scope === 'cart')
  const qualifying = cartRules.filter((r) => subtotal >= (r.minCartValue || 0))
  const unmetOffers = cartRules
    .filter((r) => subtotal < (r.minCartValue || 0))
    .map((r) => ({
      ruleId: r.ruleId,
      label: ruleToReasoning(r),
      minCartValue: r.minCartValue,
      shortBy: r.minCartValue - subtotal,
    }))
    .sort((a, b) => a.shortBy - b.shortBy)

  if (qualifying.length === 0) {
    return { subtotal, total: subtotal, cartOffer: null, unmetOffers }
  }

  const nonStackable = qualifying
    .filter((r) => !r.stackable)
    .sort((a, b) => calculateDiscountAmount(subtotal, b) - calculateDiscountAmount(subtotal, a))
  const stackable = qualifying.filter((r) => r.stackable)
  const toApply = [...nonStackable.slice(0, 1), ...stackable]

  let total = subtotal
  for (const rule of toApply) total -= calculateDiscountAmount(total, rule)
  total = Math.round(total)

  return {
    subtotal,
    total,
    cartOffer: {
      appliedRules: toApply.map((r) => r.ruleId),
      skippedRules: nonStackable.slice(1).map((r) => r.ruleId),
      label: toApply.map(ruleToReasoning).join(' + '),
      saving: subtotal - total,
    },
    unmetOffers,
  }
}

/**
 * Full checkout: item-level discounts, then cart-level offers on the sum.
 * This is the one entry point the UI calls.
 */
export function calculateCheckout(cartItems, rules) {
  const items = processCart(cartItems, rules)
  return { items, ...applyCartOffers(cartTotal(items), rules) }
}

/**
 * The brief's order (item offers first, cart offer on what's left) has a trap:
 * item offers can pull a cart below a cart-offer threshold, so the customer
 * pays more than with fewer discounts. This doesn't change the price (the
 * brief's algorithm stands); it reports the conflict so a person can decide.
 *
 * Returns null, or { ruleId, label, minCartValue, subtotal, baseSubtotal,
 * totalWithoutItemOffers, extraPaid }.
 */
export function findCartOfferConflict(checkout, rules) {
  if (checkout.cartOffer && checkout.unmetOffers.length === 0) return null
  const baseSubtotal = checkout.items.reduce((s, i) => s + i.basePrice, 0)
  const lost = checkout.unmetOffers.find((o) => baseSubtotal >= o.minCartValue)
  if (!lost) return null
  const withoutItemOffers = applyCartOffers(baseSubtotal, rules).total
  if (withoutItemOffers >= checkout.total) return null
  return {
    ruleId: lost.ruleId,
    label: lost.label,
    minCartValue: lost.minCartValue,
    subtotal: checkout.subtotal,
    baseSubtotal,
    totalWithoutItemOffers: withoutItemOffers,
    extraPaid: checkout.total - withoutItemOffers,
  }
}

/**
 * What adding `rule` would do to this cart, computed with the real engine.
 * Used by the confirm step so nobody activates a promotion blind.
 *
 * regression: true when the customer would pay MORE after adding a discount
 * (the item offer drops the cart under a cart-offer threshold).
 */
export function simulateRule(cartItems, rules, rule) {
  if (!cartItems.length) return null
  const before = calculateCheckout(cartItems, rules)
  const after = calculateCheckout(cartItems, [...rules, rule])
  const changes = after.items
    .map((it, i) => ({ itemId: it.itemId, product: it.product, basePrice: it.basePrice, before: before.items[i].finalPrice, after: it.finalPrice }))
    .filter((c) => c.before !== c.after)
  const matched = cartItems.filter((i) => ruleMatchesItem(i, rule)).length
  const cartOfferBefore = before.cartOffer?.saving ?? 0
  const cartOfferAfter = after.cartOffer?.saving ?? 0
  const maxEffective = after.items.reduce((m, it) => Math.max(m, it.basePrice ? it.totalDiscount / it.basePrice : 0), 0)
  return {
    before: before.total,
    after: after.total,
    subtotalBefore: before.subtotal,
    subtotalAfter: after.subtotal,
    cartOfferBefore,
    cartOfferAfter,
    changes,
    itemCount: cartItems.length,
    matched,
    // the rule matches items but loses to an existing offer on every one of them
    neverWins: rule.scope !== 'cart' && matched > 0 && changes.length === 0,
    regression: after.total > before.total,
    cartOfferLost: cartOfferBefore > 0 && cartOfferAfter === 0,
    maxEffectiveDiscount: Math.round(maxEffective * 100),
  }
}
