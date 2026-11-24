import { describe, it, expect } from 'vitest'
import { ApiError } from '@google/genai'
import { parseRuleText, MODEL, FALLBACK_MODEL, setRetryDelayForTests } from '../server/parseRule.js'

const fakeClient = (response, capture = {}) => ({
  models: { generateContent: async (params) => { capture.params = params; return response } },
})
const resp = (text, finishReason = 'STOP', extra = {}) => ({ text, candidates: [{ finishReason }], ...extra })
const textResponse = (obj) => resp(JSON.stringify(obj))

describe('server parseRuleText', () => {
  it('sends a schema-constrained request and returns the draft', async () => {
    const cap = {}
    const draft = { status: 'ok', scope: 'platform', applies_to: 'Flipkart', type: 'flat', value: 100, stackable: false, min_cart_value: 0, clarification: '' }
    const res = await parseRuleText('Rs.100 flat discount on all Flipkart items', { brands: [], platforms: ['Flipkart'] }, fakeClient(textResponse(draft), cap))
    expect(res).toEqual({ ok: true, draft })
    expect(cap.params.model).toBe(MODEL)
    expect(cap.params.config.responseMimeType).toBe('application/json')
    expect(cap.params.config.responseJsonSchema.required).toContain('status')
    expect(cap.params.config.systemInstruction).toContain('Known platforms: Flipkart')
  })

  it('rejects empty and over-long input before calling the LLM', async () => {
    expect((await parseRuleText('   ', {}, fakeClient(null))).status).toBe(400)
    expect((await parseRuleText('x'.repeat(501), {}, fakeClient(null))).status).toBe(400)
  })

  it('handles refusals and truncated output', async () => {
    expect((await parseRuleText('hi', {}, fakeClient(resp(undefined, 'SAFETY')))).status).toBe(422)
    expect((await parseRuleText('hi', {}, fakeClient({ promptFeedback: { blockReason: 'OTHER' } }))).status).toBe(422)
    expect((await parseRuleText('hi', {}, fakeClient(resp('{"sta', 'MAX_TOKENS')))).ok).toBe(false)
  })

  it('turns API errors into plain messages', async () => {
    const failing = (status) => ({ models: { generateContent: async () => { throw new ApiError({ message: 'x', status }) } } })
    expect((await parseRuleText('hi', {}, failing(429))).status).toBe(429)
    const badKey = { models: { generateContent: async () => { throw new ApiError({ status: 400, message: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}' }) } } }
    const res = await parseRuleText('hi', {}, badKey)
    expect(res.message).toMatch(/GEMINI_API_KEY/)
    expect(res.message).toContain('API key not valid')
  })

  it('retries without the schema when Gemini rejects the schema', async () => {
    const calls = []
    const draft = { status: 'ok', scope: 'cart', applies_to: '', type: 'percentage', value: 10, stackable: false, min_cart_value: 5000, clarification: '' }
    const flaky = { models: { generateContent: async (p) => {
      calls.push(!!p.config.responseJsonSchema)
      if (p.config.responseJsonSchema) throw new ApiError({ status: 400, message: '{"error":{"message":"Invalid JSON payload: unknown field additionalProperties"}}' })
      return textResponse(draft)
    } } }
    expect(await parseRuleText('10% off over Rs.5,000', {}, flaky)).toEqual({ ok: true, draft })
    expect(calls).toEqual([true, false])
  })

  it('retries a busy model, then falls back to the backup model', async () => {
    setRetryDelayForTests(0)
    const draft = { status: 'ok', scope: 'platform', applies_to: 'Noon', type: 'percentage', value: 5, stackable: false, min_cart_value: 0, clarification: '' }
    const busy = () => new ApiError({ status: 503, message: '{"error":{"message":"This model is currently experiencing high demand."}}' })
    const models = []
    const client = { models: { generateContent: async (p) => {
      models.push(p.model)
      if (p.model === MODEL) throw busy()
      return textResponse(draft)
    } } }
    expect(await parseRuleText('5% off on Noon', {}, client)).toEqual({ ok: true, draft })
    expect(models).toEqual([MODEL, MODEL, FALLBACK_MODEL])

    // Everything busy: a plain "try again" message, not a raw error.
    const allBusy = { models: { generateContent: async () => { throw busy() } } }
    const res = await parseRuleText('5% off on Noon', {}, allBusy)
    expect(res).toMatchObject({ ok: false, status: 503 })
    expect(res.message).toMatch(/busy right now/)
  })

  it('uses the backup model when the main one is out of quota', async () => {
    const models = []
    const client = { models: { generateContent: async (p) => {
      models.push(p.model)
      if (p.model === MODEL) throw new ApiError({ status: 429, message: 'quota' })
      return textResponse({ status: 'ambiguous', clarification: 'x' })
    } } }
    expect((await parseRuleText('hi', {}, client)).ok).toBe(true)
    expect(models).toEqual([MODEL, FALLBACK_MODEL])
  })

  it('uses the backup model when the key has no access to the main one', async () => {
    const models = []
    const client = { models: { generateContent: async (p) => {
      models.push(p.model)
      if (p.model === MODEL) throw new ApiError({ status: 404, message: 'models/x is not found' })
      return textResponse({ status: 'ambiguous', clarification: 'x' })
    } } }
    expect((await parseRuleText('hi', {}, client)).ok).toBe(true)
    expect(models).toEqual([MODEL, FALLBACK_MODEL])
  })

  it('asks Google for a current Flash model when neither configured name exists', async () => {
    const used = []
    const models = [
      { name: 'models/gemini-9.0-flash-image', supportedActions: ['generateContent'] },
      { name: 'models/gemini-9.0-flash-preview-05', supportedActions: ['generateContent'] },
      { name: 'models/gemini-8.5-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-9.0-flash', supportedActions: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedActions: ['embedContent'] },
    ]
    const client = { models: {
      list: async () => (async function* () { yield* models })(),
      generateContent: async (p) => {
        used.push(p.model)
        if (p.model !== 'gemini-9.0-flash') throw new ApiError({ status: 404, message: 'not found' })
        return textResponse({ status: 'ambiguous', clarification: 'x' })
      },
    } }
    expect((await parseRuleText('hi', {}, client)).ok).toBe(true)
    expect(used).toEqual([MODEL, FALLBACK_MODEL, 'gemini-9.0-flash'])
  })

  it('handles invalid JSON from the model', async () => {
    const res = await parseRuleText('hi', {}, fakeClient(resp('not json')))
    expect(res).toMatchObject({ ok: false, status: 502 })
  })

  it('explains a missing API key instead of crashing', async () => {
    const saved = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    const res = await parseRuleText('20% off Natura Casa')
    if (saved) process.env.GEMINI_API_KEY = saved
    expect(res).toMatchObject({ ok: false, status: 503 })
  })
})

describe('public endpoint protection', () => {
  it('limits each client per minute, then lets them back in', async () => {
    const { createRateLimiter } = await import('../server/rateLimit.js')
    let t = 0
    const check = createRateLimiter({ perClient: 2, global: 100, windowMs: 60_000, now: () => t })
    expect(check('a').ok).toBe(true)
    expect(check('a').ok).toBe(true)
    expect(check('a')).toEqual({ ok: false, retryAfter: 60 })
    expect(check('b').ok).toBe(true) // other clients unaffected
    t = 60_001
    expect(check('a').ok).toBe(true)
  })

  it('caps all clients together too', async () => {
    const { createRateLimiter } = await import('../server/rateLimit.js')
    const check = createRateLimiter({ perClient: 10, global: 2, now: () => 0 })
    check('a'); check('b')
    expect(check('c').ok).toBe(false)
  })

  it('answers 429 with Retry-After, and 413 for oversized bodies, without calling the LLM', async () => {
    const { handleParseRuleRequest } = await import('../server/parseRule.js')
    const blocked = await handleParseRuleRequest({ text: 'x' }, { clientId: '1.2.3.4' }, () => ({ ok: false, retryAfter: 42 }))
    expect(blocked).toMatchObject({ status: 429, headers: { 'Retry-After': '42' } })
    const big = await handleParseRuleRequest({ text: 'x' }, { bodyBytes: 100_000 }, () => ({ ok: true }))
    expect(big.status).toBe(413)
  })
})
