import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { parseRulesCSV, parseCartCSV } from '../src/inputs/csv.js'
import { calculateCheckout, applyCartOffers } from '../src/engine/discountEngine.js'

const rules = parseRulesCSV(fs.readFileSync('sample-data/rules.csv', 'utf8'))
const cart = parseCartCSV(fs.readFileSync('sample-data/cart.csv', 'utf8'))

describe('sample data (expected results from the brief)', () => {
  it('loads every row', () => {
    expect(rules.errors).toEqual([])
    expect(cart.errors).toEqual([])
    expect(rules.data).toHaveLength(4)
    expect(rules.data[3]).toMatchObject({ ruleId: 'RULE-04', scope: 'cart', minCartValue: 4000 })
  })

  const checkout = calculateCheckout(cart.data, rules.data)
  const byId = Object.fromEntries(checkout.items.map((i) => [i.itemId, i]))

  it.each([
    ['ITEM-01', 1104, ['RULE-01']],
    ['ITEM-02', 629, ['RULE-02', 'RULE-03']],
    ['ITEM-03', 509, ['RULE-01']],
    ['ITEM-04', 2499, []],
    ['ITEM-05', 382, ['RULE-01']],
    ['ITEM-06', 809, ['RULE-03']],
  ])('%s → Rs.%i', (id, price, applied) => {
    expect(byId[id].finalPrice).toBe(price)
    expect(byId[id].appliedRules).toEqual(applied)
  })

  it('explains why RULE-01 beat RULE-02 on ITEM-01', () => {
    expect(byId['ITEM-01'].skippedRules).toEqual(['RULE-02'])
    expect(byId['ITEM-01'].reasoning).toBe('Platform offer: 15% off (better deal than Brand offer: Rs.150 off)')
  })

  it('gives ITEM-04 a meaningful no-offer message', () => {
    expect(byId['ITEM-04'].reasoning).toMatch(/^No offers available/)
    expect(byId['ITEM-04'].reasoning).toContain('LivSpace Pro')
  })

  it('applies RULE-04 to the cart: 5,932 → 5,339', () => {
    expect(checkout.subtotal).toBe(5932)
    expect(checkout.cartOffer).toMatchObject({ appliedRules: ['RULE-04'], label: 'Cart offer: 10% off', saving: 593 })
    expect(checkout.total).toBe(5339)
  })

  it('cart rules never match individual items', () => {
    for (const item of checkout.items) expect(item.appliedRules).not.toContain('RULE-04')
  })
})

describe('cart offer threshold', () => {
  const r4 = { ruleId: 'RULE-04', scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 4000 }

  it('applies at exactly the threshold', () => {
    expect(applyCartOffers(4000, [r4])).toMatchObject({ total: 3600, cartOffer: { saving: 400 } })
  })

  it('does not apply Rs.1 below, and reports how far off', () => {
    const res = applyCartOffers(3999, [r4])
    expect(res.cartOffer).toBeNull()
    expect(res.total).toBe(3999)
    expect(res.unmetOffers[0]).toMatchObject({ ruleId: 'RULE-04', shortBy: 1 })
  })

  it('picks the bigger of two non-stackable cart offers and stacks stackable ones', () => {
    const flat = { ...r4, ruleId: 'C2', type: 'flat', value: 500 }
    const extra = { ...r4, ruleId: 'C3', value: 5, stackable: true, minCartValue: 0 }
    const res = applyCartOffers(6000, [r4, flat, extra])
    // 10% of 6000 = 600 beats 500 flat; then 5% of 5400 = 270
    expect(res.cartOffer.appliedRules).toEqual(['RULE-04', 'C3'])
    expect(res.cartOffer.skippedRules).toEqual(['C2'])
    expect(res.total).toBe(5130)
  })
})

describe('edge cases', () => {
  it('a flat discount larger than the price stops at zero', () => {
    const big = { ruleId: 'X', scope: 'brand', appliesTo: 'Natura Casa', type: 'flat', value: 5000, stackable: false, minCartValue: 0 }
    const res = calculateCheckout([cart.data[0]], [big])
    expect(res.items[0].finalPrice).toBe(0)
  })

  it('brand and platform matching ignores case and spacing', () => {
    const r = { ruleId: 'X', scope: 'platform', appliesTo: '  amazon india ', type: 'percentage', value: 15, stackable: false, minCartValue: 0 }
    expect(calculateCheckout([cart.data[0]], [r]).items[0].finalPrice).toBe(1104)
  })
})

describe('rule impact preview (confirm step)', () => {
  it('shows how many items change and the new total', async () => {
    const { previewImpact } = await import('../src/components/RuleComposer.jsx')
    const r5 = { ruleId: 'RULE-05', scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: 0 }
    expect(previewImpact(r5, rules.data, cart.data)).toEqual({ changed: 2, before: 5339, after: 5026 })
    expect(previewImpact(r5, rules.data, [])).toBeNull()
  })
})
