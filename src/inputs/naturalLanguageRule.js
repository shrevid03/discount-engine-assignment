/**
 * naturalLanguageRule.js — plain-English rule input adapter.
 *
 * Sends the text to /api/parse-rule (which calls the LLM server-side), then
 * validates whatever comes back with the same validateRule() the CSV path
 * uses. Nothing reaches the engine until the user confirms the draft.
 *
 * Result shapes:
 *   { status: 'ok', rule, warnings[] }          → show the confirm/discard card
 *   { status: 'ambiguous', message }            → ask the user to be more specific
 *   { status: 'unsupported', message }          → a real offer the engine can't express (cap, exclusion, date…)
 *   { status: 'error', message }                → network / config / LLM failure
 */

import { validateRule, nextId } from '../engine/models.js'

const unique = (xs) => [...new Set(xs.filter(Boolean))]

export function contextFrom(rules, cartItems) {
  return {
    brands: unique([...cartItems.map((i) => i.brand), ...rules.filter((r) => r.scope === 'brand').map((r) => r.appliesTo)]),
    platforms: unique([...cartItems.map((i) => i.platform), ...rules.filter((r) => r.scope === 'platform').map((r) => r.appliesTo)]),
  }
}

/**
 * Pure step: LLM draft → validated rule or an ambiguity message.
 * Exported for tests; it never calls the network.
 */
export function draftToRule(draft, { rules = [], cartItems = [] } = {}) {
  if (!draft || typeof draft !== 'object') {
    return { status: 'error', message: 'The LLM response was empty. Please try again.' }
  }
  if (draft.status === 'unsupported') {
    return {
      status: 'unsupported',
      message: draft.clarification || "This offer has a condition the engine can't apply, so it wasn't turned into a rule.",
    }
  }
  if (draft.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: draft.clarification || 'That description is missing details. Say how much off, and which brand, platform or cart value it applies to.',
    }
  }

  // The model always fills min_cart_value; for a cart rule, 0 almost always means
  // "no threshold was given", and that must not become a discount on every cart.
  if (draft.scope === 'cart' && !(Number(draft.min_cart_value ?? draft.minCartValue) > 0)) {
    return {
      status: 'ambiguous',
      message: 'Say the minimum cart value for this cart offer, for example "10% off carts of Rs.4,000 or more".',
    }
  }

  const { rule, errors } = validateRule({
    ...draft,
    rule_id: nextId('RULE', rules.map((r) => r.ruleId)),
  })
  if (!rule) {
    // The model said "ok" but produced something the engine can't use. Surface it
    // as unresolvable rather than guessing a fix.
    return {
      status: 'ambiguous',
      message: `Couldn't turn that into a valid rule: ${errors.join('; ')}. Please be more specific.`,
    }
  }

  const warnings = []
  const norm = (s) => s.trim().toLowerCase()
  if (rule.scope === 'brand' && !cartItems.some((i) => norm(i.brand) === norm(rule.appliesTo))) {
    warnings.push(`No item in the current cart is from the brand "${rule.appliesTo}", so this rule won't change today's prices.`)
  }
  if (rule.scope === 'platform' && !cartItems.some((i) => norm(i.platform) === norm(rule.appliesTo))) {
    warnings.push(`No item in the current cart is sold on "${rule.appliesTo}", so this rule won't change today's prices.`)
  }
  const sameTarget = rules.filter((r) => r.scope === rule.scope && norm(r.appliesTo) === norm(rule.appliesTo))
  const duplicate = sameTarget.find((r) =>
    r.type === rule.type && r.value === rule.value && r.stackable === rule.stackable &&
    r.minCartValue === rule.minCartValue)
  if (duplicate) warnings.push(`This looks the same as ${duplicate.ruleId}.`)
  else if (sameTarget.length) {
    const target = rule.scope === 'cart' ? 'The cart' : rule.appliesTo
    const list = sameTarget.map((r) => `${r.ruleId}: ${r.type === 'percentage' ? `${r.value}%` : `Rs.${r.value}`} off${r.stackable ? ', stackable' : ''}`).join('; ')
    warnings.push(`${target} already has an offer (${list}). Check whether this one should replace it.`)
  }

  return { status: 'ok', rule, warnings }
}

export async function parseRuleFromText(text, { rules = [], cartItems = [] } = {}, fetchImpl = fetch) {
  let res
  try {
    res = await fetchImpl('/api/parse-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context: contextFrom(rules, cartItems) }),
    })
  } catch {
    return { status: 'error', message: 'Could not reach the rule parser. Check your connection and try again.' }
  }
  let body = null
  try { body = await res.json() } catch { /* handled below */ }
  if (!res.ok) {
    return { status: 'error', message: body?.error || `The rule parser failed (HTTP ${res.status}).` }
  }
  return draftToRule(body?.draft, { rules, cartItems })
}
