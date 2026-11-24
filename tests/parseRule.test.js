import { describe, it, expect } from 'vitest'
import { parseRuleText, MODEL } from '../server/parseRule.js'

const fakeClient = (response, capture = {}) => ({
  beta: { messages: { create: async (params) => { capture.params = params; return response } } },
})
const textResponse = (obj, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra })

describe('server parseRuleText', () => {
  it('sends a schema-constrained request and returns the draft', async () => {
    const cap = {}
    const draft = { status: 'ok', scope: 'platform', applies_to: 'Flipkart', type: 'flat', value: 100, stackable: false, min_cart_value: 0, clarification: '' }
    const res = await parseRuleText('Rs.100 flat discount on all Flipkart items', { brands: [], platforms: ['Flipkart'] }, fakeClient(textResponse(draft), cap))
    expect(res).toEqual({ ok: true, draft })
    expect(cap.params.model).toBe(MODEL)
    expect(cap.params.output_config.format.type).toBe('json_schema')
    expect(cap.params.system).toContain('Known platforms: Flipkart')
  })

  it('rejects empty and over-long input before calling the LLM', async () => {
    expect((await parseRuleText('   ', {}, fakeClient(null))).status).toBe(400)
    expect((await parseRuleText('x'.repeat(501), {}, fakeClient(null))).status).toBe(400)
  })

  it('handles refusals and truncated output', async () => {
    expect((await parseRuleText('hi', {}, fakeClient({ stop_reason: 'refusal', content: [] }))).ok).toBe(false)
    expect((await parseRuleText('hi', {}, fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"sta' }] }))).ok).toBe(false)
  })

  it('handles invalid JSON from the model', async () => {
    const res = await parseRuleText('hi', {}, fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }))
    expect(res).toMatchObject({ ok: false, status: 502 })
  })

  it('explains a missing API key instead of crashing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const res = await parseRuleText('20% off Natura Casa')
    if (saved) process.env.ANTHROPIC_API_KEY = saved
    expect(res).toMatchObject({ ok: false, status: 503 })
  })
})
