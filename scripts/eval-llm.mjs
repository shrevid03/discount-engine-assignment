/**
 * Runs the plain-English rule parser against evals/rule-cases.json and scores it.
 *
 *   node scripts/eval-llm.mjs                      # against the live deployment
 *   node scripts/eval-llm.mjs http://localhost:5173  # against `npm run dev` (needs GEMINI_API_KEY in .env.local)
 *
 * Each case goes through the real path: /api/parse-rule (the LLM) and then
 * draftToRule (the same validation the UI uses). Writes evals/results.md.
 */
import fs from 'fs'
import { draftToRule } from '../src/inputs/naturalLanguageRule.js'

const BASE = (process.argv[2] || 'https://discount-engine-assignment-iota-nine.vercel.app').replace(/\/$/, '')
const cases = JSON.parse(fs.readFileSync(new URL('../evals/rule-cases.json', import.meta.url)))

// The sample rules and cart, so names like "amazon" can resolve to "Amazon India".
const context = {
  brands: ['Natura Casa', 'LivSpace Pro', 'Nordic Basics'],
  platforms: ['Amazon India', 'Flipkart', 'Noon'],
}
const cartItems = context.brands.flatMap((brand, i) => [{ brand, platform: context.platforms[i] }])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function describe(res) {
  if (res.status !== 'ok') return `${res.status}: ${res.message}`
  const r = res.rule
  const target = r.scope === 'cart' ? `cart ≥ Rs.${r.minCartValue}` : `${r.scope} ${r.appliesTo}`
  const amount = r.type === 'percentage' ? `${r.value}%` : `Rs.${r.value}`
  return `${target} · ${amount}${r.stackable ? ' · stackable' : ''}`
}

function score(expect, res) {
  if (expect === 'ambiguous') return res.status === 'ambiguous' ? [] : ['expected "need more detail"']
  if (res.status !== 'ok') return ['expected a rule']
  const wrong = []
  for (const [k, v] of Object.entries(expect)) {
    const got = res.rule[k]
    const same = typeof v === 'string' ? String(got).toLowerCase() === v.toLowerCase() : got === v
    if (!same) wrong.push(`${k}: expected ${v}, got ${got}`)
  }
  return wrong
}

async function parse(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/api/parse-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 429) { await sleep(15000); continue } // free-tier rate limit
    if (!res.ok) return { status: 'error', message: body.error || `HTTP ${res.status}` }
    return draftToRule(body.draft, { rules: [], cartItems })
  }
  return { status: 'error', message: 'rate limited 3 times' }
}

const rows = []
let passed = 0
for (const c of cases) {
  const res = await parse(c.text)
  const wrong = score(c.expect, res)
  if (!wrong.length) passed++
  rows.push({ ...c, got: describe(res), wrong })
  console.log(`${wrong.length ? '✗' : '✓'} ${c.text}\n    ${describe(res)}${wrong.length ? `\n    ${wrong.join('; ')}` : ''}`)
  await sleep(Number(process.env.EVAL_DELAY_MS ?? 7000)) // stay under the free tier's requests-per-minute limit
}

const errors = rows.filter((r) => r.got.startsWith('error')).length
const md = [
  '# Plain-English rule parser: eval results',
  '',
  `**${passed}/${cases.length} correct** · run ${new Date().toISOString().slice(0, 10)} against ${BASE}${errors ? ` · ${errors} request errors` : ''}`,
  '',
  'Each phrase goes through the real path: the Gemini call, then the same validation the UI uses. "Need more detail" counts as correct only where the phrase really is missing something.',
  '',
  '| | Input | Kind | Result |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.wrong.length ? '✗' : '✓'} | ${r.text} | ${r.note} | ${r.got.replace(/\|/g, '/')}${r.wrong.length ? ` (${r.wrong.join('; ')})` : ''} |`),
  '',
].join('\n')
fs.writeFileSync(new URL('../evals/results.md', import.meta.url), md)
console.log(`\n${passed}/${cases.length} correct. Wrote evals/results.md`)
