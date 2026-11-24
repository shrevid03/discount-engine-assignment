/**
 * Runs the plain-English rule parser against evals/rule-cases.json and scores it.
 *
 *   npm run eval                                   # against the live deployment
 *   npm run eval -- --retry-errors                 # re-run only cases that hit a rate limit last time
 *   npm run eval -- http://localhost:5173          # against `npm run dev` (needs GEMINI_API_KEY in .env.local)
 *
 * Gemini's free tier allows only a few requests per minute, so cases are spaced
 * out and rate-limited requests back off before retrying.
 *
 * Each case goes through the real path: /api/parse-rule (the LLM) and then
 * draftToRule (the same validation the UI uses). Writes evals/results.md.
 */
import fs from 'fs'
import { draftToRule } from '../src/inputs/naturalLanguageRule.js'

const args = process.argv.slice(2)
const RETRY_ERRORS = args.includes('--retry-errors')
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://discount-engine-assignment-iota-nine.vercel.app').replace(/\/$/, '')
const RESULTS_JSON = new URL('../evals/results.json', import.meta.url)
const previous = RETRY_ERRORS && fs.existsSync(RESULTS_JSON) ? JSON.parse(fs.readFileSync(RESULTS_JSON)) : {}
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
    if (res.status === 429) { // free-tier rate limit: back off 30s, then 60s
      if (attempt < 2) { console.log(`    rate limited, waiting ${30 * (attempt + 1)}s…`); await sleep(30000 * (attempt + 1)) }
      continue
    }
    if (!res.ok) return { status: 'error', message: body.error || `HTTP ${res.status}` }
    return draftToRule(body.draft, { rules: [], cartItems })
  }
  return { status: 'error', message: 'rate limited 3 times' }
}

const rows = []
let passed = 0
for (const c of cases) {
  const prior = previous[c.text]
  let got, wrong
  if (prior && !prior.got.startsWith('error')) {
    ({ got, wrong } = prior) // kept from the last run
  } else {
    const res = await parse(c.text)
    got = describe(res)
    wrong = score(c.expect, res)
    await sleep(Number(process.env.EVAL_DELAY_MS ?? 13000)) // stay under the free tier's requests-per-minute limit
  }
  if (!wrong.length) passed++
  rows.push({ ...c, got, wrong })
  console.log(`${wrong.length ? '✗' : '✓'} ${c.text}\n    ${got}${wrong.length ? `\n    ${wrong.join('; ')}` : ''}`)
}
fs.writeFileSync(RESULTS_JSON, JSON.stringify(Object.fromEntries(rows.map((r) => [r.text, { got: r.got, wrong: r.wrong }])), null, 2))

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
