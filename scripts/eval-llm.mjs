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
 *
 * Reported separately, because a single accuracy number hides the dangerous case:
 *   - completion: requests that got an answer (not a rate limit or outage)
 *   - exact match: answered rule cases where every expected field is right
 *   - correct refusals: answered "should refuse" cases that produced no rule
 *   - unsafe acceptances: "should refuse" cases that produced a rule anyway
 *     (e.g. "15% off up to Rs.200" turned into an uncapped 15%)
 *   - latency: median and slowest request
 */
import fs from 'fs'
import { draftToRule } from '../src/inputs/naturalLanguageRule.js'
import { parseRulesCSV } from '../src/inputs/csv.js'

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
const sampleRules = parseRulesCSV(fs.readFileSync(new URL('../sample-data/rules.csv', import.meta.url), 'utf8')).data
const REFUSED = ['ambiguous', 'unsupported']
const shouldRefuse = (expect) => expect === 'ambiguous' || expect === 'refuse'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function describe(res) {
  if (res.status !== 'ok') return `${res.status}: ${res.message}`
  const r = res.rule
  const target = r.scope === 'cart' ? `cart ≥ Rs.${r.minCartValue}` : `${r.scope} ${r.appliesTo}`
  const amount = r.type === 'percentage' ? `${r.value}%` : `Rs.${r.value}`
  return `${target} · ${amount}${r.stackable ? ' · stackable' : ''}`
}

function score(expect, res) {
  if (shouldRefuse(expect)) return REFUSED.includes(res.status) ? [] : ['expected no rule (refuse or ask for detail)']
  if (res.status !== 'ok') return ['expected a rule']
  const wrong = []
  for (const [k, v] of Object.entries(expect)) {
    if (k === 'warns') {
      if (!res.warnings.some((w) => w.includes(v))) wrong.push(`expected a warning containing "${v}"`)
      continue
    }
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
    return draftToRule(body.draft, { rules: sampleRules, cartItems })
  }
  return { status: 'error', message: 'rate limited 3 times' }
}

const rows = []
for (const c of cases) {
  const prior = previous[c.text]
  let got, wrong, status, ms
  if (prior && !prior.got.startsWith('error')) {
    ({ got, wrong, status, ms } = prior) // kept from the last run
  } else {
    const t0 = Date.now()
    const res = await parse(c.text)
    ms = Date.now() - t0
    status = res.status
    got = describe(res)
    wrong = score(c.expect, res)
    await sleep(Number(process.env.EVAL_DELAY_MS ?? 13000)) // stay under the free tier's requests-per-minute limit
  }
  rows.push({ ...c, category: c.category ?? 'core', got, wrong, status, ms })
  console.log(`${status === 'error' ? '…' : wrong.length ? '✗' : '✓'} ${c.text}\n    ${got}${wrong.length ? `\n    ${wrong.join('; ')}` : ''}`)
}
fs.writeFileSync(RESULTS_JSON, JSON.stringify(Object.fromEntries(rows.map((r) => [r.text, { got: r.got, wrong: r.wrong, status: r.status, ms: r.ms }])), null, 2))

function metrics(rs) {
  const answered = rs.filter((r) => r.status !== 'error')
  const ruleCases = answered.filter((r) => !shouldRefuse(r.expect))
  const refuseCases = answered.filter((r) => shouldRefuse(r.expect))
  const times = answered.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b)
  return {
    total: rs.length,
    answered: answered.length,
    correct: answered.filter((r) => !r.wrong.length).length,
    exact: `${ruleCases.filter((r) => !r.wrong.length).length}/${ruleCases.length}`,
    refusals: `${refuseCases.filter((r) => !r.wrong.length).length}/${refuseCases.length}`,
    unsafe: refuseCases.filter((r) => r.status === 'ok').length,
    median: times.length ? `${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s` : 'n/a',
    max: times.length ? `${(times[times.length - 1] / 1000).toFixed(1)}s` : 'n/a',
  }
}

const all = metrics(rows)
const categories = [...new Set(rows.map((r) => r.category))]
const md = [
  '# Plain-English rule parser: eval results',
  '',
  `**${all.correct}/${all.answered} answered cases correct** · ${all.answered}/${all.total} requests completed · **${all.unsafe} unsafe acceptances** · run ${new Date().toISOString().slice(0, 10)} against ${BASE}`,
  '',
  'Each phrase goes through the real path: the Gemini call, then the same validation the UI uses. "Refuse" cases pass only if no rule is produced (the model asks for detail or says the engine can\'t apply the condition). An **unsafe acceptance** is a refuse case that produced a rule anyway, for example "15% off up to Rs.200" becoming an uncapped 15%. That is the failure that matters most, so it is counted on its own.',
  '',
  '| Category | Completed | Exact field match | Correct refusals | Unsafe acceptances | Median latency | Slowest |',
  '|---|---|---|---|---|---|---|',
  ...categories.map((cat) => {
    const m = metrics(rows.filter((r) => r.category === cat))
    return `| ${cat} | ${m.answered}/${m.total} | ${m.exact} | ${m.refusals} | ${m.unsafe} | ${m.median} | ${m.max} |`
  }),
  `| **all** | ${all.answered}/${all.total} | ${all.exact} | ${all.refusals} | ${all.unsafe} | ${all.median} | ${all.max} |`,
  '',
  ...categories.flatMap((cat) => [
    `## ${cat}`,
    '',
    '| | Input | Kind | Result |',
    '|---|---|---|---|',
    ...rows.filter((r) => r.category === cat).map((r) => `| ${r.status === 'error' ? 'not run' : r.wrong.length ? '✗' : '✓'} | ${r.text} | ${r.note} | ${r.got.replace(/\|/g, '/')}${r.wrong.length && r.status !== 'error' ? ` (${r.wrong.join('; ')})` : ''} |`),
    '',
  ]),
].join('\n')
fs.writeFileSync(new URL('../evals/results.md', import.meta.url), md)
console.log(`\n${all.correct}/${all.answered} answered correctly (${all.answered}/${all.total} completed), ${all.unsafe} unsafe acceptances. Wrote evals/results.md`)
