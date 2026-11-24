/**
 * CartSummary.jsx
 *
 * Customer-facing checkout view: one row per item, then the cart subtotal,
 * the cart offer row (only when a cart rule qualifies) and the final total.
 */

import DataTable from './DataTable.jsx'
import { formatRupees } from '../engine/discountEngine.js'

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
      <span style={{ color: row.appliedRules.length ? '#131A48' : '#888', fontStyle: row.appliedRules.length ? 'normal' : 'italic' }}>
        {v}
      </span>
    ),
  },
]

const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0.35rem 0', fontSize: 13 }

export default function CartSummary({ checkout }) {
  const { items, subtotal, cartOffer, unmetOffers, total } = checkout
  const itemSavings = items.reduce((s, r) => s + r.totalDiscount, 0)
  const nextOffer = unmetOffers[0]

  return (
    <div>
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
