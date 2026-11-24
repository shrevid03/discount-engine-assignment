/**
 * Quick check of the live site's plain-English path with the real Gemini model:
 * each phrase goes to /api/parse-rule, through the same validation as the UI,
 * and (for rules) through the same impact preview the confirm card shows.
 *
 *   npm run smoke                       # against the live deployment
 *   npm run smoke -- http://localhost:5173
 */
import fs from 'fs'
import { draftToRule, contextFrom } from '../src/inputs/naturalLanguageRule.js'
import { parseRulesCSV, parseCartCSV } from '../src/inputs/csv.js'
import { simulateRule, formatRupees } from '../src/engine/discountEngine.js'

const BASE = (process.argv[2] || 'https://discount-engine-assignment-iota-nine.vercel.app').replace(/\/$/, '')
const read = (f) => fs.readFileSync(new URL(`../sample-data/${f}`, import.meta.url), 'utf8')
const rules = parseRulesCSV(read('rules.csv')).data
const carts = { sample: parseCartCSV(read('cart.csv')).data, threshold: parseCartCSV(read('cart-threshold.csv')).data }

const CHECKS = [
  ['threshold', 'Rs.1 off on Nordic Basics', (r, sim) => r.status === 'ok' && sim.regression && sim.after - sim.before === 399],
  ['sample', '20% off for Natura Casa brand, stackable with other offers', (r, sim) => r.status === 'ok' && sim.after === 5026],
  ['sample', '15% off on Flipkart, up to ₹200', (r) => r.status === 'unsupported' || r.status === 'ambiguous'],
  ['sample', 'Give a discount for big orders', (r) => r.status === 'ambiguous' || r.status === 'unsupported'],
  ['sample', '10% off if cart value is more than Rs.5,000', (r) => r.status === 'ok' && r.rule.minCartValue === 5000],
  ['sample', 'Add another 10% Flipkart discount', (r) => r.status === 'ok' && r.warnings.some((w) => w.includes('already has an offer'))],
  ['sample', 'Flipkart pe 100 rupaye off sab products par', (r) => r.status === 'ok' && r.rule.appliesTo === 'Flipkart' && r.rule.type === 'flat' && r.rule.value === 100],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
for (const [cartName, text, ok] of CHECKS) {
  const cartItems = carts[cartName]
  let res
  for (let attempt = 0; attempt < 3; attempt++) {
    const http = await fetch(`${BASE}/api/parse-rule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context: contextFrom(rules, cartItems) }),
    })
    const body = await http.json().catch(() => ({}))
    if (http.status === 429 || http.status === 503) { console.log(`   (busy, waiting 30s)`); await sleep(30000); continue }
    res = http.ok ? draftToRule(body.draft, { rules, cartItems }) : { status: 'error', message: body.error || `HTTP ${http.status}` }
    break
  }
  res ??= { status: 'error', message: 'still busy after 3 tries' }
  const sim = res.status === 'ok' ? simulateRule(cartItems, rules, res.rule) : null
  const good = res.status !== 'error' && ok(res, sim)
  if (good) passed++
  const detail = res.status === 'ok'
    ? `rule: ${res.rule.scope} ${res.rule.appliesTo || ''} ${res.rule.type === 'percentage' ? `${res.rule.value}%` : formatRupees(res.rule.value)}${res.rule.scope === 'cart' ? ` when cart ≥ ${formatRupees(res.rule.minCartValue)}` : ''}${res.rule.stackable ? ' stackable' : ''} · checkout ${formatRupees(sim.before)} → ${formatRupees(sim.after)}${sim.regression ? ' · RED WARNING (customer pays more)' : ''}${res.warnings.length ? ` · warning: ${res.warnings.join(' / ')}` : ''}`
    : `${res.status}: ${res.message}`
  console.log(`${good ? '✓' : '✗'} ${text}\n   ${detail}`)
  await sleep(15000)
}
console.log(`\n${passed}/${CHECKS.length} live checks passed against ${BASE}`)
