/**
 * App.jsx
 *
 * Top-level component. Holds the session state (rules, cart) and wires the
 * input adapters to the engine:
 *
 *   inputs/csv.js                 ─┐
 *   inputs/pdfCart.js              ├─→ DiscountRule[] / CartItem[] ─→ engine.calculateCheckout ─→ CartSummary
 *   inputs/naturalLanguageRule.js ─┘
 *
 * Adding another input mode means writing another adapter that returns the
 * same shapes. The engine doesn't change.
 */

import { useMemo, useState } from 'react'
import FileUploader from './components/FileUploader.jsx'
import DataTable from './components/DataTable.jsx'
import ErrorBanner from './components/ErrorBanner.jsx'
import RuleComposer from './components/RuleComposer.jsx'
import CartSummary from './components/CartSummary.jsx'
import { parseRulesCSV, parseCartCSV } from './inputs/csv.js'
import { parseCartPDF } from './inputs/pdfCart.js'
import { calculateCheckout, formatRupees } from './engine/discountEngine.js'
import sampleRulesCsv from '../sample-data/rules.csv?raw'
import sampleCartCsv from '../sample-data/cart.csv?raw'
import thresholdCartCsv from '../sample-data/cart-threshold.csv?raw'
import sampleCartPdf from '../sample-data/cart.pdf?url'
import sampleSmallPdf from '../sample-data/cart-small.pdf?url'
import sampleMalformedPdf from '../sample-data/cart-malformed.pdf?url'

const SAMPLE_PDFS = [
  { href: sampleCartPdf, name: 'cart.pdf', hint: 'the 6-item sample cart' },
  { href: sampleSmallPdf, name: 'cart-small.pdf', hint: 'just below the cart-offer threshold' },
  { href: sampleMalformedPdf, name: 'cart-malformed.pdf', hint: 'has bad rows' },
]

// One-click scenarios for reviewers: each loads its data and calculates at once.
const SCENARIOS = [
  { id: 'standard', title: 'Standard checkout', blurb: "The brief's 6 items: competing offers, stacking and the cart offer" },
  { id: 'paradox', title: 'Discount paradox', blurb: 'A cart on the Rs.4,000 line, where Rs.1 off costs the customer Rs.399' },
  { id: 'llm', title: 'Plain-English rule', blurb: 'Text → model → validated rule → impact preview' },
  { id: 'pdf-bad', title: 'PDF with bad rows', blurb: 'An incomplete order is held for review, not silently loaded' },
  { id: 'near', title: 'Just below the offer', blurb: 'A PDF cart just short of the Rs.4,000 cart offer' },
]

const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1)

const CART_COLUMNS = [
  { key: 'itemId',    label: 'Item' },
  { key: 'product',   label: 'Product' },
  { key: 'brand',     label: 'Brand' },
  { key: 'platform',  label: 'Platform' },
  { key: 'basePrice', label: 'Base Price', render: (v) => formatRupees(v) },
]

// ── Styles ───────────────────────────────────────────────────────

const S = {
  page:    { minHeight: '100vh', background: '#f7f7f9', fontFamily: 'Arial, sans-serif' },
  header:  { background: '#131A48', padding: '0.85rem 2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logoTxt: { fontFamily: 'Georgia, serif', fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' },
  logoSpan:{ color: '#FF5800' },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.07em' },
  main:    { maxWidth: 1040, margin: '0 auto', padding: '1.8rem 1.5rem' },
  section: { background: '#fff', border: '1px solid #CECECE', borderRadius: 6, padding: '1.2rem 1.4rem', marginBottom: '1.2rem', minWidth: 0 },
  sectionTitle: { fontFamily: 'Georgia, serif', fontWeight: 700, fontSize: 14, color: '#131A48', marginBottom: '0.7rem', paddingBottom: 6, borderBottom: '2px solid #FF5800', display: 'inline-block' },
  grid2:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1rem' },
  btn:     {
    background: '#FF5800', color: '#fff', border: 'none', borderRadius: 4,
    padding: '0.65rem 2rem', fontSize: 13, fontWeight: 700, cursor: 'pointer',
    letterSpacing: '0.04em', textTransform: 'uppercase',
  },
  btnDisabled: {
    background: '#CECECE', color: '#fff', border: 'none', borderRadius: 4,
    padding: '0.65rem 2rem', fontSize: 13, fontWeight: 700, cursor: 'not-allowed',
    letterSpacing: '0.04em', textTransform: 'uppercase',
  },
  note: { fontSize: 11, color: '#888', marginBottom: 4 },
  demoBar: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', alignItems: 'center', fontSize: 12, color: '#555', marginBottom: '1rem' },
  scenGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.6rem', marginBottom: '1.1rem' },
  scen: { textAlign: 'left', background: '#fff', border: '1px solid #CECECE', borderTop: '3px solid #FF5800', borderRadius: 6, padding: '0.6rem 0.8rem', cursor: 'pointer', fontFamily: 'inherit' },
  demoBtn: { background: '#fff', border: '1px solid #131A48', color: '#131A48', borderRadius: 4, padding: '0.35rem 0.9rem', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
}

// ── Component ────────────────────────────────────────────────────

export default function App() {
  const [rules, setRules]           = useState([])
  const [rulesErrors, setRulesErr]  = useState([])
  const [rulesSource, setRulesSource] = useState('')

  const [cartItems, setCartItems]   = useState([])
  const [cartErrors, setCartErrors] = useState([])
  const [cartSource, setCartSource] = useState('')
  const [cartBusy, setCartBusy]     = useState(false)

  // Once the user has calculated, results stay live: adding a rule or loading
  // a new cart re-runs the engine automatically.
  const [calculated, setCalculated] = useState(false)
  const [notice, setNotice]         = useState('')
  // A PDF with bad rows waits here until someone confirms the partial import.
  const [pendingImport, setPendingImport] = useState(null)
  const [preset, setPreset]         = useState(null)

  const checkout = useMemo(
    () => (calculated && cartItems.length > 0 ? calculateCheckout(cartItems, rules) : null),
    [calculated, cartItems, rules]
  )

  // ── Handlers ──

  function handleRulesLoad(csvText, file) {
    const { data, errors } = parseRulesCSV(csvText)
    setRules(data)
    setRulesErr(errors)
    setRulesSource(file.name)
    setNotice('')
  }

  async function handleCartLoad(contents, file, kind) {
    setNotice('')
    if (kind === 'csv') {
      const { data, errors } = parseCartCSV(contents)
      setCartItems(data)
      setCartErrors(errors)
      setCartSource(file.name)
      return
    }
    setCartBusy(true)
    setPendingImport(null)
    const { items, errors, meta } = await parseCartPDF(contents)
    setCartBusy(false)
    if (items.length === 0) {
      // Keep the current cart rather than replacing it with nothing.
      setCartErrors([`${file.name}: no cart items could be read, so the current cart was kept.`, ...errors])
      return
    }
    if (errors.length) {
      // Some rows failed. Loading the rest straight away would show a checkout
      // total for an incomplete order, so hold it until someone confirms.
      setCartErrors([])
      setPendingImport({ items, errors, meta, fileName: file.name })
      return
    }
    applyPdfCart({ items, errors, meta, fileName: file.name })
  }

  function applyPdfCart({ items, errors, meta, fileName }) {
    setPendingImport(null)
    setCartItems(items)
    setCartErrors(errors.length ? [`Incomplete cart: ${errors.length} row${errors.length > 1 ? 's' : ''} from ${fileName} could not be read and ${errors.length > 1 ? 'are' : 'is'} not included.`, ...errors] : [])
    setCartSource(`${fileName}${meta.heading ? ` · ${meta.heading}` : ''}`)
    if (calculated) setNotice(`Cart replaced with ${items.length} item${items.length > 1 ? 's' : ''} from ${fileName}. Prices recalculated.`)
  }

  function handleAddRule(rule) {
    setRules((rs) => [...rs, rule])
    if (calculated) setNotice(`${rule.ruleId} added. Prices recalculated.`)
  }

  function handleRemoveRule(ruleId) {
    setRules((rs) => rs.filter((r) => r.ruleId !== ruleId))
    if (calculated) setNotice(`${ruleId} removed. Prices recalculated.`)
  }

  function loadSamples() {
    handleRulesLoad(sampleRulesCsv, { name: 'sample rules.csv' })
    handleCartLoad(sampleCartCsv, { name: 'sample cart.csv' }, 'csv')
  }

  async function runScenario(id) {
    setPendingImport(null)
    setPreset(null)
    handleRulesLoad(sampleRulesCsv, { name: 'sample rules.csv' })
    if (id === 'pdf-bad' || id === 'near') {
      const href = id === 'pdf-bad' ? sampleMalformedPdf : sampleSmallPdf
      const name = id === 'pdf-bad' ? 'cart-malformed.pdf' : 'cart-small.pdf'
      const buf = await (await fetch(href)).arrayBuffer()
      if (id === 'pdf-bad') handleCartLoad(sampleCartCsv, { name: 'sample cart.csv' }, 'csv')
      await handleCartLoad(buf, { name }, 'pdf')
    } else if (id === 'paradox') {
      handleCartLoad(thresholdCartCsv, { name: 'cart-threshold.csv (exactly Rs.4,000)' }, 'csv')
      setPreset({ text: 'Rs.1 off on Nordic Basics' })
    } else {
      handleCartLoad(sampleCartCsv, { name: 'sample cart.csv' }, 'csv')
      if (id === 'llm') setPreset({ text: '20% off for Natura Casa brand, stackable with other offers' })
    }
    setCalculated(true)
    setNotice('')
  }

  // No active promotions is a valid state: every item shows its base price.
  const canCalculate = cartItems.length > 0

  const rulesColumns = [
    { key: 'ruleId',    label: 'Rule ID' },
    { key: 'scope',     label: 'Scope', render: cap },
    { key: 'appliesTo', label: 'Applies To', render: (v, r) => (r.scope === 'cart' ? 'Entire cart' : v) },
    { key: 'value',     label: 'Offer', render: (v, r) => (r.type === 'percentage' ? `${v}% off` : `${formatRupees(v)} off`) },
    { key: 'minCartValue', label: 'Condition', render: (v, r) => (r.scope === 'cart' && v > 0 ? `Cart ≥ ${formatRupees(v)}` : '—') },
    { key: 'stackable', label: 'Stackable', render: (v) => (v ? 'Yes' : 'No') },
    {
      key: 'remove', label: '',
      render: (_, r) => (
        <button
          onClick={() => handleRemoveRule(r.ruleId)} aria-label={`Remove ${r.ruleId}`} title="Remove rule"
          style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 13 }}
        >✕</button>
      ),
    },
  ]

  // ── Render ──

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.logoTxt}>O<span style={S.logoSpan}>pp</span>tra</div>
        <div style={S.headerSub}>Discount Engine</div>
      </div>

      <div style={S.main}>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}><b style={{ color: '#131A48' }}>Try a scenario</b> · each one loads its data and calculates</div>
        <div style={S.scenGrid}>
          {SCENARIOS.map((sc) => (
            <button key={sc.id} type="button" style={S.scen} onClick={() => runScenario(sc.id)} data-testid={`scenario-${sc.id}`}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#131A48' }}>{sc.title}</div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sc.blurb}</div>
            </button>
          ))}
        </div>

        <div style={S.demoBar}>
          <button type="button" style={S.demoBtn} onClick={loadSamples}>Load sample data</button>
          <span>
            Sample cart PDFs to upload:{' '}
            {SAMPLE_PDFS.map((f, i) => (
              <span key={f.name}>
                {i > 0 && ' · '}
                <a href={f.href} download={f.name} title={f.hint} style={{ color: '#131A48' }}>{f.name}</a>
              </span>
            ))}
          </span>
        </div>

        <div style={S.grid2}>
          {/* Rules */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Discount Rules</div>
            <FileUploader
              label="rules.csv"
              accept=".csv"
              description="Upload your discount rules CSV"
              onLoad={handleRulesLoad}
              hasData={!!rulesSource}
              fileName={rulesSource}
            />
            <ErrorBanner errors={rulesErrors} />
            {rules.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div style={S.note}>{rules.length} rule{rules.length > 1 ? 's' : ''} active</div>
                <DataTable columns={rulesColumns} rows={rules} />
              </div>
            )}
            <RuleComposer rules={rules} cartItems={cartItems} onAdd={handleAddRule} preset={preset} />
          </div>

          {/* Cart */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Cart Items</div>
            <FileUploader
              label="Cart (CSV or PDF)"
              accept=".csv,.pdf,application/pdf"
              description="Upload cart.csv or a cart PDF"
              onLoad={handleCartLoad}
              hasData={cartItems.length > 0}
              fileName={cartSource}
              busy={cartBusy}
            />
            <ErrorBanner errors={cartErrors} />
            {pendingImport && (
              <div role="alert" data-testid="pdf-review" style={{ border: '1px solid #d4a017', borderLeft: '3px solid #d4a017', background: '#fff8e1', borderRadius: 4, padding: '0.7rem 0.9rem', marginTop: '0.6rem', fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: '#6b5000', marginBottom: 4 }}>Review this PDF import: {pendingImport.fileName}</div>
                <div style={{ color: '#5a4300' }}>
                  Rows found: <b>{pendingImport.items.length + pendingImport.errors.length}</b> · readable: <b>{pendingImport.items.length}</b> · could not be read: <b>{pendingImport.errors.length}</b>
                </div>
                <ul style={{ margin: '4px 0 6px', paddingLeft: 18, color: '#5a4300' }}>
                  {pendingImport.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
                <div style={{ color: '#5a4300' }}>
                  {cartItems.length ? 'Your current cart has not changed. ' : ''}
                  Importing now would price an incomplete order, missing the rows above.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button type="button" style={{ ...S.demoBtn, background: '#FF5800', color: '#fff', border: 'none' }} onClick={() => applyPdfCart(pendingImport)}>
                    Import {pendingImport.items.length} readable item{pendingImport.items.length > 1 ? 's' : ''}
                  </button>
                  <button type="button" style={S.demoBtn} onClick={() => setPendingImport(null)}>
                    {cartItems.length ? 'Keep current cart' : 'Cancel'}
                  </button>
                </div>
              </div>
            )}
            {cartItems.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div style={S.note}>{cartItems.length} item{cartItems.length > 1 ? 's' : ''} in cart</div>
                <DataTable columns={CART_COLUMNS} rows={cartItems} />
              </div>
            )}
          </div>
        </div>

        {!calculated && (
          <div style={{ textAlign: 'center', marginBottom: '1.2rem' }}>
            <button
              style={canCalculate ? S.btn : S.btnDisabled}
              onClick={() => setCalculated(true)}
              disabled={!canCalculate}
            >
              Calculate Discounts
            </button>
            {!canCalculate && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                Load a cart to calculate
              </div>
            )}
            {canCalculate && rules.length === 0 && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                No rules loaded, so every item will show its base price
              </div>
            )}
          </div>
        )}

        {checkout && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Cart Summary</div>
            {notice && (
              <div role="status" style={{ fontSize: 12, color: '#1e5c2c', marginBottom: 8 }}>{notice}</div>
            )}
            <CartSummary checkout={checkout} rules={rules} />
          </div>
        )}
      </div>
    </div>
  )
}
