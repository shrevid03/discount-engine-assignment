/**
 * parseRule.js — server-side LLM call that turns a plain-English description
 * into a draft DiscountRule.
 *
 * Runs on the server (a Vercel function in production, Vite middleware in dev)
 * so the Anthropic API key never reaches the browser.
 *
 * The model is constrained to a JSON schema with structured outputs, but its
 * answer is still treated as untrusted: the browser re-validates it with the
 * same validateRule() the CSV path uses before showing the confirm step.
 */

import Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-opus-5-5'
export const MAX_INPUT_CHARS = 500

const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'scope', 'applies_to', 'type', 'value', 'stackable', 'min_cart_value', 'clarification'],
  properties: {
    status: { type: 'string', enum: ['ok', 'ambiguous'] },
    scope: { type: 'string', enum: ['brand', 'platform', 'cart', 'unknown'] },
    applies_to: { type: 'string' },
    type: { type: 'string', enum: ['percentage', 'flat', 'unknown'] },
    value: { type: 'number' },
    stackable: { type: 'boolean' },
    min_cart_value: { type: 'number' },
    clarification: { type: 'string' },
  },
}

function systemPrompt({ brands = [], platforms = [] }) {
  return `You convert a shop manager's plain-English discount description into one structured discount rule for a cart pricing engine.

Fields:
- scope: "brand" (applies to every item of one brand), "platform" (every item sold on one marketplace), or "cart" (applies to the whole cart total once it reaches a minimum value).
- applies_to: the brand or platform name for brand/platform scope. Use "" for cart scope. If the name matches one of the known names below (ignoring case, spacing or small typos), use the known spelling exactly.
- type: "percentage" or "flat" (a fixed rupee amount off).
- value: the number only. 20% off -> 20. Rs.100 off -> 100.
- stackable: true only if the text says the offer stacks / combines / applies on top of other offers. Otherwise false.
- min_cart_value: for cart scope, the minimum cart total in rupees. "more than", "over", "above" or "at least" Rs.X all mean X. Use 0 for brand/platform scope.
- clarification: "" when status is "ok".

Known brands: ${brands.length ? brands.join(', ') : '(none loaded)'}
Known platforms: ${platforms.length ? platforms.join(', ') : '(none loaded)'}

Set status to "ambiguous" instead of guessing when any required detail is missing or unclear: no discount amount, no way to tell percentage from flat, no brand/platform named for an item-level rule, a cart rule with no minimum value, more than one rule described at once, or text that is not a discount rule at all. When ambiguous, set clarification to one short sentence telling the user exactly what to add, with an example, and fill unknown fields with "unknown", "" or 0.

Never invent a value, threshold or name the text does not state.`
}

/**
 * @returns {Promise<{ ok: true, draft: object } | { ok: false, status: number, message: string }>}
 */
export async function parseRuleText(text, context = {}, client = null) {
  const input = typeof text === 'string' ? text.trim() : ''
  if (!input) return { ok: false, status: 400, message: 'Describe the rule first.' }
  if (input.length > MAX_INPUT_CHARS) {
    return { ok: false, status: 400, message: `Keep the description under ${MAX_INPUT_CHARS} characters.` }
  }
  if (!client && !process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      status: 503,
      message: 'Plain-English rules are not configured on this deployment (ANTHROPIC_API_KEY is not set).',
    }
  }

  const anthropic = client ?? new Anthropic()
  let response
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RULE_SCHEMA } },
      system: systemPrompt(context),
      messages: [{ role: 'user', content: `<rule_description>\n${input}\n</rule_description>` }],
    })
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, status: 502, message: 'The LLM API key was rejected. Check ANTHROPIC_API_KEY.' }
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, status: 429, message: 'Too many requests to the LLM right now. Try again in a moment.' }
    }
    return { ok: false, status: 502, message: `The LLM request failed (${err?.message ?? 'unknown error'}).` }
  }

  if (response.stop_reason === 'refusal') {
    return { ok: false, status: 422, message: 'The model declined to parse that text. Rephrase it as a discount rule.' }
  }
  const textBlock = response.content.find((b) => b.type === 'text')
  if (response.stop_reason === 'max_tokens' || !textBlock) {
    return { ok: false, status: 502, message: 'The LLM returned an incomplete answer. Try again.' }
  }
  try {
    return { ok: true, draft: JSON.parse(textBlock.text) }
  } catch {
    return { ok: false, status: 502, message: 'The LLM returned something that is not valid JSON. Try again.' }
  }
}

/** Shared HTTP handler for Vercel and the Vite dev server. */
export async function handleParseRuleRequest(body) {
  const { text, context } = body ?? {}
  const result = await parseRuleText(text, {
    brands: Array.isArray(context?.brands) ? context.brands.slice(0, 50).map(String) : [],
    platforms: Array.isArray(context?.platforms) ? context.platforms.slice(0, 50).map(String) : [],
  })
  return result.ok
    ? { status: 200, json: { draft: result.draft } }
    : { status: result.status, json: { error: result.message } }
}
