/**
 * RuleComposer.jsx
 *
 * Plain-English rule input: text box → LLM parse → confirm or discard.
 * Owns only the UI flow. Parsing and validation live in inputs/naturalLanguageRule.js,
 * and the confirmed rule is handed to the parent with onAdd(rule).
 */

import { useEffect, useState } from 'react'
import { parseRuleFromText } from '../inputs/naturalLanguageRule.js'
import { formatRupees, simulateRule } from '../engine/discountEngine.js'

const EXAMPLES = [
  '20% off for Natura Casa brand, stackable with other offers',
  'Rs.100 flat discount on all Flipkart items',
  '10% off if cart value is more than Rs.5,000',
]

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

export function describeRule(rule) {
  return [
    ['Scope', cap(rule.scope)],
    ...(rule.scope === 'cart' ? [] : [['Applies to', rule.appliesTo]]),
    ['Type', cap(rule.type)],
    ['Value', rule.type === 'percentage' ? `${rule.value}%` : formatRupees(rule.value)],
    // Spelled out so "more than Rs.5,000" read as "Rs.5,000 or more" is visible before confirming.
    ...(rule.scope === 'cart' ? [['Applies when', `cart total is ${formatRupees(rule.minCartValue)} or more`]] : []),
    ['Stackable', rule.stackable ? 'Yes' : 'No'],
  ]
}

/** Effective discounts above this get a warning: a margin floor nobody set on purpose. */
const HIGH_DISCOUNT = 40

const box = (border, bg) => ({
  border: `1px solid ${border}`, borderLeft: `3px solid ${border}`, background: bg,
  borderRadius: 4, padding: '0.6rem 0.9rem', marginTop: '0.6rem', fontSize: 12,
})

const btn = (primary, disabled) => ({
  background: disabled ? '#CECECE' : primary ? '#FF5800' : '#fff',
  color: primary || disabled ? '#fff' : '#131A48',
  border: primary || disabled ? 'none' : '1px solid #131A48',
  borderRadius: 4, padding: '0.45rem 1rem', fontSize: 12, fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', letterSpacing: '0.03em',
})

export default function RuleComposer({ rules, cartItems, onAdd, preset }) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null) // { status, rule?, warnings?, message? }

  // A scenario button can drop text into the box. Parsing stays a separate click,
  // so whoever is watching sees the real model call happen.
  useEffect(() => {
    if (preset) { setText(preset.text); setResult(null) }
  }, [preset])

  async function handleParse(e) {
    e?.preventDefault()
    if (!text.trim() || pending) return
    setPending(true)
    setResult(null)
    const res = await parseRuleFromText(text, { rules, cartItems })
    setResult(res)
    setPending(false)
  }

  function confirm() {
    onAdd(result.rule)
    setResult(null)
    setText('')
  }

  const impact = result?.status === 'ok' ? simulateRule(cartItems, rules, result.rule) : null

  return (
    <div style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid #eee' }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#131A48' }}>Add a rule in plain English</div>
      <form onSubmit={handleParse}>
        <textarea
          aria-label="Describe a discount rule"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleParse(e) }}
          placeholder={`e.g. "${EXAMPLES[0]}"`}
          rows={2}
          maxLength={500}
          disabled={pending || result?.status === 'ok'}
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '0.5rem 0.6rem',
            border: '1px solid #CECECE', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
          {result?.status !== 'ok' && (
            <button type="submit" style={btn(true, pending || !text.trim())} disabled={pending || !text.trim()}>
              {pending ? 'Parsing…' : 'Parse rule'}
            </button>
          )}
          {!pending && !result && EXAMPLES.map((ex) => (
            <button
              key={ex} type="button" onClick={() => setText(ex)}
              style={{ background: 'none', border: '1px dashed #CECECE', borderRadius: 20, padding: '2px 8px', fontSize: 11, color: '#555', cursor: 'pointer' }}
            >
              {ex}
            </button>
          ))}
        </div>
      </form>

      {result?.status === 'ambiguous' && (
        <div role="alert" style={box('#d4a017', '#fff8e1')}>
          <div style={{ fontWeight: 700, color: '#6b5000', marginBottom: 2 }}>Need a bit more detail</div>
          <div style={{ color: '#5a4300' }}>{result.message}</div>
        </div>
      )}

      {result?.status === 'unsupported' && (
        <div role="alert" style={box('#d4a017', '#fff8e1')} data-testid="rule-unsupported">
          <div style={{ fontWeight: 700, color: '#6b5000', marginBottom: 2 }}>The engine can't apply this offer as written</div>
          <div style={{ color: '#5a4300' }}>{result.message}</div>
          <div style={{ color: '#5a4300', marginTop: 4 }}>
            It wasn't turned into a simpler rule, because dropping the condition would charge customers the wrong price.
          </div>
        </div>
      )}

      {result?.status === 'error' && (
        <div role="alert" style={box('#c0392b', '#fce8e8')}>
          <div style={{ fontWeight: 700, color: '#8a1a1a', marginBottom: 2 }}>Couldn't parse the rule</div>
          <div style={{ color: '#5a1010' }}>{result.message}</div>
          <div style={{ color: '#5a1010', marginTop: 4 }}>You can still add rules by uploading a rules CSV above.</div>
        </div>
      )}

      {result?.status === 'ok' && (
        <div style={box(impact?.regression ? '#c0392b' : '#131A48', impact?.regression ? '#fff5f5' : '#f4f5fb')} data-testid="rule-confirm">
          <div style={{ fontWeight: 700, color: '#131A48', marginBottom: 6 }}>
            Check this rule before adding it as {result.rule.ruleId}
          </div>
          <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {describeRule(result.rule).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ color: '#666', padding: '1px 12px 1px 0' }}>{k}</td>
                  <td style={{ color: '#131A48', fontWeight: 600 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {impact && <ImpactPreview impact={impact} />}

          {result.warnings.map((w) => (
            <div key={w} style={{ color: '#6b5000', marginTop: 6 }}>⚠ {w}</div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={btn(true)} onClick={confirm}>
              {impact?.regression ? 'Add anyway' : 'Confirm & add'}
            </button>
            <button type="button" style={btn(false)} onClick={() => setResult(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Campaign impact: what this rule does to the current cart, from the real engine. */
function ImpactPreview({ impact }) {
  const delta = impact.before - impact.after
  const cell = { padding: '2px 10px 2px 0', whiteSpace: 'nowrap' }
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #dde', paddingTop: 8 }} data-testid="rule-impact">
      {impact.regression && (
        <div role="alert" style={{ background: '#fce8e8', border: '1px solid #c0392b', borderRadius: 4, padding: '6px 8px', marginBottom: 8, color: '#8a1a1a' }} data-testid="rule-regression">
          <div style={{ fontWeight: 700 }}>This discount makes the customer pay {formatRupees(-delta)} more</div>
          <div style={{ marginTop: 2 }}>
            It lowers the cart from {formatRupees(impact.subtotalBefore)} to {formatRupees(impact.subtotalAfter)}, below a cart offer's threshold,
            so the cart discount {impact.cartOfferAfter > 0
              ? `falls from ${formatRupees(impact.cartOfferBefore)} to ${formatRupees(impact.cartOfferAfter)}`
              : `of ${formatRupees(impact.cartOfferBefore)} no longer applies`}. The brief's order (item offers first, then the cart offer) causes this.
            Review the promotion before adding it.
          </div>
        </div>
      )}
      <div style={{ fontWeight: 700, color: '#131A48', marginBottom: 4 }}>Effect on the current cart</div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 6 }}>
        <Stat label="Checkout now" value={formatRupees(impact.before)} />
        <Stat label="After this rule" value={formatRupees(impact.after)} strong />
        <Stat
          label={delta >= 0 ? 'Extra customer savings' : 'Customer pays more'}
          value={formatRupees(Math.abs(delta))}
          color={delta > 0 ? '#1e5c2c' : delta < 0 ? '#8a1a1a' : '#555'}
        />
        <Stat label="Items affected" value={`${impact.changes.length} of ${impact.itemCount}`} />
      </div>
      {impact.changes.length > 0 && (
        <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            {impact.changes.map((c) => (
              <tr key={c.itemId}>
                <td style={{ ...cell, color: '#131A48' }}>{c.product}</td>
                <td style={{ ...cell, color: '#666' }}>{formatRupees(c.before)} → <b style={{ color: '#131A48' }}>{formatRupees(c.after)}</b></td>
                <td style={{ ...cell, color: '#1e5c2c' }}>−{formatRupees(c.before - c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ color: '#555', marginTop: 4 }}>
        {impact.cartOfferBefore === 0 && impact.cartOfferAfter === 0 && 'No cart offer applies before or after.'}
        {impact.cartOfferBefore > 0 && impact.cartOfferAfter > 0 && (impact.cartOfferAfter === impact.cartOfferBefore || impact.subtotalAfter === impact.subtotalBefore
          ? `Cart offer still applies (${formatRupees(impact.cartOfferAfter)} off).`
          : `Cart offer changes from ${formatRupees(impact.cartOfferBefore)} to ${formatRupees(impact.cartOfferAfter)} off.`)}
        {impact.cartOfferBefore === 0 && impact.cartOfferAfter > 0 && `Cart now qualifies for a cart offer (${formatRupees(impact.cartOfferAfter)} off).`}
        {impact.cartOfferLost && `Cart offer lost (was ${formatRupees(impact.cartOfferBefore)} off).`}
      </div>
      {impact.neverWins && (
        <div style={{ color: '#6b5000', marginTop: 6 }}>⚠ This rule matches {impact.matched} item{impact.matched === 1 ? '' : 's'} but an existing offer beats it on every one, so it changes nothing today.</div>
      )}
      {impact.maxEffectiveDiscount > HIGH_DISCOUNT && (
        <div style={{ color: '#6b5000', marginTop: 6 }}>⚠ With this rule one item would be {impact.maxEffectiveDiscount}% off its base price. Check that the margin allows it.</div>
      )}
    </div>
  )
}

function Stat({ label, value, strong, color = '#131A48' }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#777', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: strong ? 15 : 13, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}
