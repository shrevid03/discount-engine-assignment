import { describe, it, expect } from 'vitest'
import { ApiError } from '@google/genai'
import { parseRuleText, MODEL } from '../server/parseRule.js'

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
