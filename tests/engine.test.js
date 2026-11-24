import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { parseRulesCSV, parseCartCSV } from '../src/inputs/csv.js'
import { calculateCheckout, applyCartOffers, applyDiscounts, simulateRule, findCartOfferConflict } from '../src/engine/discountEngine.js'

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
  it('returns nothing when there is no cart to preview against', () => {
    const r5 = { ruleId: 'RULE-05', scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: 0 }
    expect(simulateRule([], rules.data, r5)).toBeNull()
  })
})

describe('ties, traces and empty rule sets', () => {
  const item = { itemId: 'I', product: 'Lamp', brand: 'B', platform: 'P', basePrice: 1000 }
  const r = (ruleId, scope, appliesTo, type, value, stackable = false) => ({ ruleId, scope, appliesTo, type, value, stackable, minCartValue: 0 })

  it('says "same saving" on a tie, not "better deal", and keeps the first-listed offer', () => {
    const res = applyDiscounts(item, [r('R1', 'brand', 'B', 'flat', 150), r('R2', 'platform', 'P', 'percentage', 15)])
    expect(res.appliedRules).toEqual(['R1'])
    expect(res.reasoning).toBe('Brand offer: Rs.150 off (same saving as Platform offer: 15% off)')
  })

  it('records every matching rule and what it did', () => {
    const res = applyDiscounts(item, [r('R1', 'brand', 'B', 'flat', 100), r('R2', 'platform', 'P', 'percentage', 20), r('R3', 'brand', 'B', 'percentage', 10, true)])
    expect(res.steps).toEqual([
      { ruleId: 'R2', label: 'Platform offer: 20% off', status: 'best', saving: 200, from: 1000, to: 800 },
      { ruleId: 'R1', label: 'Brand offer: Rs.100 off', status: 'not used', saving: 100 },
      { ruleId: 'R3', label: 'Brand offer: 10% off', status: 'stacked', saving: 80, from: 800, to: 720 },
    ])
  })

  it('prices a cart with no rules at all', () => {
    const res = calculateCheckout(cart.data, [])
    expect(res.total).toBe(6594)
    expect(res.cartOffer).toBeNull()
    expect(res.items.every((i) => i.reasoning.startsWith('No offers available'))).toBe(true)
  })
})

describe('promotion safety: a discount that raises the price', () => {
  const thresholdCart = parseCartCSV(fs.readFileSync('sample-data/cart-threshold.csv', 'utf8')).data
  const rs1 = { ruleId: 'RULE-05', scope: 'brand', appliesTo: 'Nordic Basics', type: 'flat', value: 1, stackable: false, minCartValue: 0 }

  it('sample cart sits exactly on the Rs.4,000 threshold', () => {
    const res = calculateCheckout(thresholdCart, rules.data)
    expect(res.subtotal).toBe(4000)
    expect(res.total).toBe(3600)
  })

  it('flags that Rs.1 off makes the customer pay Rs.399 more', () => {
    const sim = simulateRule(thresholdCart, rules.data, rs1)
    expect(sim).toMatchObject({
      before: 3600, after: 3999, subtotalBefore: 4000, subtotalAfter: 3999,
      cartOfferBefore: 400, cartOfferAfter: 0, regression: true, cartOfferLost: true,
    })
    expect(sim.changes).toEqual([{ itemId: 'ITEM-02', product: 'Floor Lamp', basePrice: 1501, before: 1501, after: 1500 }])
  })

  it('explains the conflict on the checkout itself once the rule is live', () => {
    const live = calculateCheckout(thresholdCart, [...rules.data, rs1])
    expect(findCartOfferConflict(live, [...rules.data, rs1])).toMatchObject({
      ruleId: 'RULE-04', subtotal: 3999, baseSubtotal: 4000, totalWithoutItemOffers: 3600, extraPaid: 399,
    })
    expect(findCartOfferConflict(calculateCheckout(cart.data, rules.data), rules.data)).toBeNull()
  })

  it('reports a normal rule as a saving, with per-item changes', () => {
    const sim = simulateRule(cart.data, rules.data, { ...rs1, appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true })
    expect(sim).toMatchObject({ before: 5339, after: 5026, regression: false, cartOfferLost: false, neverWins: false })
    expect(sim.changes.map((c) => [c.itemId, c.before, c.after])).toEqual([['ITEM-01', 1104, 883], ['ITEM-02', 629, 503]])
    expect(sim.maxEffectiveDiscount).toBe(41)
  })

  it('notices a rule that never beats the existing offer', () => {
    const weak = { ...rs1, scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 5 }
    expect(simulateRule(cart.data, rules.data, weak)).toMatchObject({ matched: 3, neverWins: true, after: 5339 })
  })

  it('stays accurate with two cart offers when only the bigger one is lost', () => {
    const cartRules = [
      { ruleId: 'C-BIG', scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 4000 },
      { ruleId: 'C-SMALL', scope: 'cart', appliesTo: '', type: 'flat', value: 100, stackable: false, minCartValue: 2000 },
    ]
    const sim = simulateRule(thresholdCart, cartRules, rs1)
    // Rs.4,000 - 400 = 3,600 before; after, 3,999 only meets the Rs.2,000 offer: 3,999 - 100 = 3,899
    expect(sim).toMatchObject({ before: 3600, after: 3899, cartOfferBefore: 400, cartOfferAfter: 100, regression: true, cartOfferLost: false })
    const live = calculateCheckout(thresholdCart, [...cartRules, rs1])
    expect(live.cartOffer.appliedRules).toEqual(['C-SMALL'])
    expect(findCartOfferConflict(live, [...cartRules, rs1])).toMatchObject({
      ruleId: 'C-BIG', minCartValue: 4000, totalWithoutItemOffers: 3600, extraPaid: 299,
    })
  })
})
