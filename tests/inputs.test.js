import { describe, it, expect } from 'vitest'
import fs from 'fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parseRulesCSV } from '../src/inputs/csv.js'
import { cartFromTextRuns, textRunsFromPdf } from '../src/inputs/pdfCart.js'
import { draftToRule } from '../src/inputs/naturalLanguageRule.js'
import { validateRule } from '../src/engine/models.js'

const pdf = async (path) => cartFromTextRuns(await textRunsFromPdf(new Uint8Array(fs.readFileSync(path)), pdfjs))

describe('CSV rules', () => {
  it('reports bad rows by number and keeps the good ones', () => {
    const { data, errors } = parseRulesCSV(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value\n' +
      'A,platform,Flipkart,percentage,10,true,\n' +
      'B,region,India,percentage,10,false,\n' +
      'C,cart,,percentage,abc,false,4000\n'
    )
    expect(data.map((r) => r.ruleId)).toEqual(['A'])
    expect(errors[0]).toMatch(/^Row 3 skipped: scope must be/)
    expect(errors[1]).toMatch(/^Row 4 skipped: value must be/)
  })

  it('still reads the original 6-column rules.csv (no min_cart_value column)', () => {
    const { data, errors } = parseRulesCSV('rule_id,scope,applies_to,type,value,stackable\nA,brand,X,flat,100,false')
    expect(errors).toEqual([])
    expect(data[0]).toMatchObject({ minCartValue: 0 })
  })
})

describe('PDF cart', () => {
  it('reads the sample cart PDF into the same items as cart.csv', async () => {
    const { items, errors, meta } = await pdf('sample-data/cart.pdf')
    expect(errors).toEqual([])
    expect(meta.heading).toContain('OP-9921')
    expect(items).toHaveLength(6)
    expect(items[0]).toEqual({ itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 })
    expect(items[3]).toMatchObject({ product: 'Ceramic Vase', platform: 'Noon', basePrice: 2499 })
  })

  it('skips malformed rows with a reason and keeps the rest', async () => {
    const { items, errors } = await pdf('sample-data/cart-malformed.pdf')
    expect(items.map((i) => i.product)).toEqual(['Cushion Cover', 'Desk Organiser'])
    expect(items.map((i) => i.itemId)).toEqual(['ITEM-01', 'ITEM-02'])
    expect(errors).toHaveLength(3)
    expect(errors[0]).toMatch(/^Row 2 skipped \("Bed Sheet Set.*\): missing Base Price$/)
    expect(errors.join('\n')).toMatch(/Wall Shelf.*base price must be a positive rupee amount \(got "Rs.TBD"\)/)
    expect(errors[2]).toMatch(/^Row 4 skipped .*: missing Brand$/)
  })

  // PDFs printed from a browser (HTML tables), not made by our own generator.
  it.each([
    ['chrome-bordered.pdf', 6],
    ['chrome-rupee-symbol-total-row.pdf', 6], // "₹ 1,299", right-aligned prices, a Total row
  ])('reads %s', async (file, count) => {
    const { items, errors } = await pdf(`tests/fixtures/${file}`)
    expect(errors).toEqual([])
    expect(items).toHaveLength(count)
    expect(items.map((i) => i.basePrice)).toEqual([1299, 849, 599, 2499, 449, 899])
  })

  it('joins product, brand and platform names that wrap onto several lines', async () => {
    const { items, errors } = await pdf('tests/fixtures/chrome-wrapped-cells.pdf')
    expect(errors).toEqual([])
    expect(items[0]).toMatchObject({
      product: 'Premium Handwoven Cotton Cushion Cover Set', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299,
    })
    expect(items[1]).toMatchObject({ product: 'Wall Shelf', basePrice: 599 })
  })

  it('falls back to splitting on wide gaps when a row is one text run', () => {
    const runs = [
      { str: 'Product   Brand   Platform   Base Price', x: 10, y: 700, page: 1 },
      { str: 'Wall Shelf    LivSpace Pro    Amazon India    Rs.599', x: 10, y: 680, page: 1 },
      { str: 'Vase | Nordic Basics | Noon | 1,250', x: 10, y: 660, page: 1 },
    ]
    const { items, errors } = cartFromTextRuns(runs)
    expect(errors).toEqual([])
    expect(items.map((i) => i.basePrice)).toEqual([599, 1250])
  })

  it('explains a PDF with no table header', () => {
    const { items, errors } = cartFromTextRuns([{ str: 'Hello world', x: 0, y: 0, page: 1 }])
    expect(items).toEqual([])
    expect(errors[0]).toMatch(/Product, Brand, Platform and Base Price/)
  })

  it('explains a PDF with no text layer', () => {
    expect(cartFromTextRuns([]).errors[0]).toMatch(/scanned image/)
  })
})

describe('LLM draft → rule', () => {
  const ctx = {
    rules: parseRulesCSV(fs.readFileSync('sample-data/rules.csv', 'utf8')).data,
    cartItems: [{ itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 }],
  }
  const ok = (o) => ({ status: 'ok', applies_to: '', stackable: false, min_cart_value: 0, clarification: '', ...o })

  it('turns the brief\'s first example into RULE-05', () => {
    const res = draftToRule(ok({ scope: 'brand', applies_to: 'Natura Casa', type: 'percentage', value: 20, stackable: true }), ctx)
    expect(res).toEqual({
      status: 'ok', warnings: [],
      rule: { ruleId: 'RULE-05', scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: 0 },
    })
  })

  it('cart rule keeps its threshold and drops applies_to', () => {
    const res = draftToRule(ok({ scope: 'cart', applies_to: 'everything', type: 'percentage', value: 10, min_cart_value: 5000 }), ctx)
    expect(res.rule).toMatchObject({ scope: 'cart', appliesTo: '', minCartValue: 5000 })
  })

  it('passes the model\'s clarification through for ambiguous input', () => {
    const res = draftToRule({ status: 'ambiguous', clarification: 'How much off, and from what cart value?' }, ctx)
    expect(res).toEqual({ status: 'ambiguous', message: 'How much off, and from what cart value?' })
  })

  it('treats an "ok" answer that fails validation as unresolvable, not as a rule', () => {
    const res = draftToRule(ok({ scope: 'unknown', type: 'percentage', value: 0 }), ctx)
    expect(res.status).toBe('ambiguous')
    expect(res.message).toMatch(/scope must be/)
    expect(res.message).toMatch(/value must be a positive number/)
  })

  it('rejects percentages of 100 or more', () => {
    expect(draftToRule(ok({ scope: 'platform', applies_to: 'Flipkart', type: 'percentage', value: 150 }), ctx).status).toBe('ambiguous')
  })

  it('warns when the rule matches nothing in the cart', () => {
    const res = draftToRule(ok({ scope: 'platform', applies_to: 'Myntra', type: 'flat', value: 100 }), ctx)
    expect(res.status).toBe('ok')
    expect(res.warnings[0]).toMatch(/Myntra/)
  })

  it('handles garbage from the API without throwing', () => {
    expect(draftToRule(null, ctx).status).toBe('error')
    expect(draftToRule('nope', ctx).status).toBe('error')
  })
})

describe('validateRule', () => {
  it('accepts Rs-formatted strings from any source', () => {
    expect(validateRule({ rule_id: 'R', scope: 'cart', type: 'flat', value: 'Rs.250', stackable: 'no', min_cart_value: 'Rs.3,000' }).rule)
      .toMatchObject({ value: 250, minCartValue: 3000, stackable: false })
  })
})
