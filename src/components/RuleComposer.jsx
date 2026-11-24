/**
 * RuleComposer.jsx
 *
 * Plain-English rule input: text box → LLM parse → confirm or discard.
 * Owns only the UI flow. Parsing and validation live in inputs/naturalLanguageRule.js,
 * and the confirmed rule is handed to the parent with onAdd(rule).
 */

import { useState } from 'react'
import { parseRuleFromText } from '../inputs/naturalLanguageRule.js'
import { formatRupees } from '../engine/discountEngine.js'

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
    ...(rule.scope === 'cart' ? [['Min cart value', formatRupees(rule.minCartValue)]] : []),
    ['Stackable', rule.stackable ? 'Yes' : 'No'],
  ]
}

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

export default function RuleComposer({ rules, cartItems, onAdd }) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null) // { status, rule?, warnings?, message? }

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

      {result?.status === 'error' && (
        <div role="alert" style={box('#c0392b', '#fce8e8')}>
          <div style={{ fontWeight: 700, color: '#8a1a1a', marginBottom: 2 }}>Couldn't parse the rule</div>
          <div style={{ color: '#5a1010' }}>{result.message}</div>
        </div>
      )}

      {result?.status === 'ok' && (
        <div style={box('#131A48', '#f4f5fb')} data-testid="rule-confirm">
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
          {result.warnings.map((w) => (
            <div key={w} style={{ color: '#6b5000', marginTop: 6 }}>⚠ {w}</div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={btn(true)} onClick={confirm}>Confirm &amp; add</button>
            <button type="button" style={btn(false)} onClick={() => setResult(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  )
}
