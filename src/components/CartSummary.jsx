/**
 * CartSummary.jsx
 *
 * Customer-facing checkout view: headline totals, one row per item (each with
 * a "why this price?" breakdown built from the engine's own calculation steps),
 * then the cart subtotal, the cart offer row (only when a cart rule qualifies)
 * and the final total.
 */

import DataTable from './DataTable.jsx'
import { formatRupees, findCartOfferConflict } from '../engine/discountEngine.js'

const STATUS_TEXT = { best: 'Applied (biggest saving)', 'not used': 'Not used', stacked: 'Applied on top (stackable)' }

/** Expandable breakdown, straight from the engine's steps: no second explanation to drift. */
function WhyThisPrice({ row }) {
  if (!row.steps.length) return null
  const best = row.steps.find((s) => s.status === 'best')
  const unused = row.steps.filter((s) => s.status === 'not used')
  return (
    <details style={{ marginTop: 3 }}>
      <summary style={{ cursor: 'pointer', color: '#FF5800', fontSize: 11, fontWeight: 700 }}>Why this price?</summary>
      <table style={{ fontSize: 11, borderCollapse: 'collapse', marginTop: 4 }}>
        <tbody>
          <tr>
            <td style={{ color: '#666', padding: '1px 10px 1px 0' }}>Base price</td>
            <td />
            <td style={{ textAlign: 'right' }}>{formatRupees(row.basePrice)}</td>
          </tr>
          {row.steps.map((s) => (
            <tr key={s.ruleId} style={{ color: s.status === 'not used' ? '#999' : '#131A48' }}>
              <td style={{ padding: '1px 10px 1px 0' }}>{s.ruleId} · {s.label}</td>
              <td style={{ padding: '1px 10px 1px 0', fontStyle: 'italic' }}>{STATUS_TEXT[s.status]}</td>
              <td style={{ textAlign: 'right', textDecoration: s.status === 'not used' ? 'line-through' : 'none' }}>−{formatRupees(s.saving)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700, borderTop: '1px solid #ddd' }}>
            <td style={{ padding: '2px 10px 1px 0' }}>Final price</td>
            <td />
            <td style={{ textAlign: 'right' }}>{formatRupees(row.finalPrice)}</td>
          </tr>
        </tbody>
      </table>
      {best && unused.length > 0 && (
        <div style={{ color: '#555', marginTop: 3, maxWidth: 340 }}>
          {unused.every((u) => u.saving === best.saving)
            ? `These offers save the same amount, and only one non-stackable offer can apply, so the one listed first (${best.ruleId}) was used.`
            : `Only one non-stackable offer can apply, so ${best.ruleId} was used: it saves ${formatRupees(best.saving - Math.max(...unused.map((u) => u.saving)))} more than the next best.`}
        </div>
      )}
    </details>
  )
}

const RESULTS_COLUMNS = [
  { key: 'itemId',    label: 'Item' },
  { key: 'product',   label: 'Product' },
  { key: 'basePrice', label: 'Base Price', render: (v) => formatRupees(v) },
  {
    key: 'finalPrice',
    label: 'Final Price',
    render: (v, row) => (
      <span style={{ fontWeight: 700, color: row.totalDiscount > 0 ? '#1e5c2c' : '#131A48' }}>
        {formatRupees(v)}
      </span>
    ),
  },
  {
    key: 'totalDiscount',
    label: 'You Save',
    render: (v) =>
      v > 0
        ? <span style={{ color: '#1e5c2c', fontWeight: 600 }}>{formatRupees(v)}</span>
        : <span style={{ color: '#888' }}>—</span>,
  },
  {
    key: 'reasoning',
    label: 'Offer Applied',
    wrap: true,
    render: (v, row) => (
      <div>
        <span style={{ color: row.appliedRules.length ? '#131A48' : '#888', fontStyle: row.appliedRules.length ? 'normal' : 'italic' }}>
          {v}
        </span>
        <WhyThisPrice row={row} />
      </div>
    ),
  },
]

const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0.35rem 0', fontSize: 13 }

const tile = { flex: '1 1 150px', background: '#f7f7f9', border: '1px solid #e3e3e8', borderRadius: 6, padding: '0.6rem 0.9rem' }
const tileLabel = { fontSize: 10, color: '#777', textTransform: 'uppercase', letterSpacing: '0.06em' }

export default function CartSummary({ checkout, rules = [] }) {
  const { items, subtotal, cartOffer, unmetOffers, total } = checkout
  const itemSavings = items.reduce((s, r) => s + r.totalDiscount, 0)
  const original = items.reduce((s, r) => s + r.basePrice, 0)
  const nextOffer = unmetOffers[0]
  const conflict = findCartOfferConflict(checkout, rules)

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', marginBottom: '0.9rem' }} data-testid="summary-tiles">
        <div style={tile}><div style={tileLabel}>Original cart</div><div style={{ fontSize: 18, fontWeight: 700, color: '#131A48' }}>{formatRupees(original)}</div></div>
        <div style={tile}><div style={tileLabel}>Total savings</div><div style={{ fontSize: 18, fontWeight: 700, color: '#1e5c2c' }}>{formatRupees(original - total)}</div></div>
        <div style={{ ...tile, background: '#131A48', borderColor: '#131A48' }}><div style={{ ...tileLabel, color: 'rgba(255,255,255,0.6)' }}>Final payable</div><div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>{formatRupees(total)}</div></div>
      </div>

      {conflict && (
        <div role="alert" style={{ background: '#fff5f5', border: '1px solid #c0392b', borderLeft: '3px solid #c0392b', borderRadius: 4, padding: '0.6rem 0.9rem', marginBottom: '0.9rem', fontSize: 12, color: '#8a1a1a' }} data-testid="cart-offer-conflict">
          <b>Pricing conflict (for the operator):</b> item offers brought this cart from {formatRupees(conflict.baseSubtotal)} down to {formatRupees(conflict.subtotal)},
          below the {formatRupees(conflict.minCartValue)} threshold for the cart offer ({conflict.label}). The customer pays {formatRupees(total)}; without the item offers they would pay {formatRupees(conflict.totalWithoutItemOffers)}, {formatRupees(conflict.extraPaid)} less.
          Prices follow the brief's order, so this needs a policy decision rather than a silent fix.
        </div>
      )}

      <DataTable columns={RESULTS_COLUMNS} rows={items} />

      <div style={{ marginLeft: 'auto', maxWidth: 420, marginTop: '0.9rem' }} data-testid="cart-totals">
        <div style={row}>
          <span style={{ color: '#555' }}>{cartOffer ? 'Cart total before offer' : 'Items total'}</span>
          <span style={{ color: '#131A48', fontWeight: 600 }}>{formatRupees(subtotal)}</span>
        </div>

        {cartOffer && (
          <div style={{ ...row, background: '#f0faf2', margin: '0 -0.5rem', padding: '0.4rem 0.5rem', borderRadius: 4 }} data-testid="cart-offer-row">
            <span style={{ color: '#1e5c2c', fontWeight: 600 }}>
              {cartOffer.label} — {formatRupees(cartOffer.saving)} saved
            </span>
            <span style={{ color: '#1e5c2c', fontWeight: 700 }}>−{formatRupees(cartOffer.saving)}</span>
          </div>
        )}

        {!cartOffer && nextOffer && (
          <div style={{ ...row, color: '#6b5000', fontSize: 12 }} data-testid="cart-offer-hint">
            Add {formatRupees(Math.max(1, Math.ceil(nextOffer.shortBy)))} more to unlock {nextOffer.label} (on carts of {formatRupees(nextOffer.minCartValue)} or more)
          </div>
        )}

        <div style={{ ...row, borderTop: '2px solid #131A48', marginTop: 4, paddingTop: '0.6rem' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#131A48' }}>Final Cart Total</span>
          <span style={{ fontWeight: 700, fontSize: 17, color: '#131A48' }} data-testid="final-total">{formatRupees(total)}</span>
        </div>
        {itemSavings + (cartOffer?.saving ?? 0) > 0 && (
          <div style={{ textAlign: 'right', fontSize: 12, color: '#1e5c2c' }}>
            You save {formatRupees(itemSavings + (cartOffer?.saving ?? 0))} on this order
          </div>
        )}
      </div>
    </div>
  )
}
