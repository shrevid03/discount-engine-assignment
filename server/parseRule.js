/**
 * parseRule.js — server-side LLM call that turns a plain-English description
 * into a draft DiscountRule.
 *
 * Runs on the server (a Vercel function in production, Vite middleware in dev)
 * so the Gemini API key never reaches the browser.
 *
 * The model is constrained to a JSON schema, but its answer is still treated
 * as untrusted: the browser re-validates it with the same validateRule() the
 * CSV path uses before showing the confirm step.
 */

import { GoogleGenAI, ApiError } from '@google/genai'

// Override with GEMINI_MODEL if Google retires this model name.
export const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
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
  if (!client && !process.env.GEMINI_API_KEY) {
    return {
      ok: false,
      status: 503,
      message: 'Plain-English rules are not configured on this deployment (GEMINI_API_KEY is not set).',
    }
  }

  const ai = client ?? new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // systemInstruction and responseJsonSchema are only served on v1beta.
    apiVersion: 'v1beta',
  })
  const request = (withSchema) => ai.models.generateContent({
    model: MODEL,
    contents: `<rule_description>\n${input}\n</rule_description>`,
    config: {
      systemInstruction: systemPrompt(context),
      responseMimeType: 'application/json',
      ...(withSchema ? { responseJsonSchema: RULE_SCHEMA } : {}),
      temperature: 0,
      maxOutputTokens: 2000,
    },
  })

  let response
  try {
    try {
      response = await request(true)
    } catch (err) {
      // If the model rejects the schema itself (400 that isn't about the key), retry once in
      // plain JSON mode. The prompt still describes every field, and the browser validates
      // the result, so a malformed answer can't slip through.
      if (!(err instanceof ApiError && err.status === 400) || isKeyProblem(err)) throw err
      console.warn('[parse-rule] schema request rejected, retrying without schema:', googleReason(err))
      response = await request(false)
    }
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined
    const reason = googleReason(err)
    console.error('[parse-rule] Gemini error', status, reason)
    if (isKeyProblem(err) || status === 401) {
      return { ok: false, status: 502, message: `The Gemini API key was rejected (${reason}). Check GEMINI_API_KEY in Vercel, then redeploy.` }
    }
    if (status === 403) {
      return { ok: false, status: 502, message: `Gemini refused access (${reason}).` }
    }
    if (status === 404) {
      return { ok: false, status: 502, message: `Gemini model "${MODEL}" was not found. Set GEMINI_MODEL to a current model.` }
    }
    if (status === 429) {
      return { ok: false, status: 429, message: 'Too many requests to the LLM right now (free-tier limit). Try again in a minute.' }
    }
    return { ok: false, status: 502, message: `The LLM request failed (${reason}).` }
  }

  const candidate = response?.candidates?.[0]
  if (response?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') {
    return { ok: false, status: 422, message: 'The model declined to parse that text. Rephrase it as a discount rule.' }
  }
  const raw = response?.text
  if (candidate?.finishReason === 'MAX_TOKENS' || !raw) {
    return { ok: false, status: 502, message: 'The LLM returned an incomplete answer. Try again.' }
  }
  try {
    return { ok: true, draft: JSON.parse(raw) }
  } catch {
    return { ok: false, status: 502, message: 'The LLM returned something that is not valid JSON. Try again.' }
  }
}

/** Google's own error text, pulled out of the SDK's JSON-in-a-string error message. */
function googleReason(err) {
  const raw = err?.message ?? String(err)
  const json = raw.slice(raw.indexOf('{'))
  try {
    const parsed = JSON.parse(json)
    return parsed?.error?.message ?? raw
  } catch {
    return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  }
}

function isKeyProblem(err) {
  return /api key|api_key_invalid|permission_denied.*key/i.test(err?.message ?? '')
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
