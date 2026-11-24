/**
 * models.js
 *
 * The engine's input contract. Every input mode (CSV, PDF, plain-English via
 * an LLM, or anything added later) produces loosely-typed "raw" objects and
 * passes them through these validators. Only objects that come back valid
 * ever reach the discount engine, so the engine never has to know where a rule
 * or cart item came from.
 *
 * DiscountRule {
 *   ruleId:      string
 *   scope:       "brand" | "platform" | "cart"
 *   appliesTo:   string          — brand/platform name; "" for cart rules
 *   type:        "percentage" | "flat"
 *   value:       number          — 15 = 15%, or rupees for flat
 *   stackable:   boolean
 *   minCartValue: number         — cart rules only; 0 for item rules
 * }
 *
 * CartItem {
 *   itemId, product, brand, platform: string
 *   basePrice: number            — whole rupees
 * }
 */

export const SCOPES = ['brand', 'platform', 'cart']
export const TYPES = ['percentage', 'flat']
/** Upper bound for any rupee amount (Rs.1 crore): keeps arithmetic far from float trouble. */
export const MAX_RUPEES = 10_000_000

const str = (v) => (v === undefined || v === null ? '' : String(v).trim())

/** Parses "Rs.1,299", "₹ 1299", "1299.00", 1299 → 1299. Returns NaN when not a price. */
export function parseRupees(v) {
  if (typeof v === 'number') return v
  const cleaned = str(v).replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/,/g, '').trim()
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN
  return parseFloat(cleaned)
}

function parseBool(v) {
  if (typeof v === 'boolean') return v
  const s = str(v).toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(s)) return true
  if (['false', '0', 'no', 'n', ''].includes(s)) return false
  return null
}

/**
 * Validates a raw rule. Accepts camelCase or snake_case keys so CSV rows and
 * LLM JSON can both be passed straight in.
 * Returns { rule, errors }. `rule` is null when errors is non-empty.
 */
export function validateRule(raw) {
  const errors = []
  const ruleId = str(raw.ruleId ?? raw.rule_id)
  const scope = str(raw.scope).toLowerCase()
  const type = str(raw.type).toLowerCase()
  let appliesTo = str(raw.appliesTo ?? raw.applies_to)
  const value = typeof raw.value === 'number' ? raw.value : parseRupees(raw.value)
  const stackable = parseBool(raw.stackable)
  const minRaw = raw.minCartValue ?? raw.min_cart_value
  let minCartValue = str(minRaw) === '' ? 0 : parseRupees(minRaw)

  if (!ruleId) errors.push('rule_id is missing')
  if (!SCOPES.includes(scope)) {
    errors.push(`scope must be brand, platform or cart (got "${str(raw.scope) || 'nothing'}")`)
  }
  if (!TYPES.includes(type)) {
    errors.push(`type must be percentage or flat (got "${str(raw.type) || 'nothing'}")`)
  }
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`value must be a positive number (got "${str(raw.value) || 'nothing'}")`)
  } else if (type === 'percentage' && value >= 100) {
    // Policy choice: a 100% "discount" is a free item, which is a different
    // business decision from a promotion, so it isn't accepted as a rule.
    errors.push(`a percentage discount must be below 100% (got ${value}%)`)
  } else if (value > MAX_RUPEES) {
    errors.push(`value is too large (got ${value})`)
  }
  if (stackable === null) errors.push(`stackable must be true or false (got "${str(raw.stackable)}")`)

  if (scope === 'cart') {
    appliesTo = ''
    // A blank threshold must not quietly become "every cart qualifies". A cart
    // offer for every cart is allowed, but only when someone writes 0 on purpose.
    if (str(minRaw) === '') {
      errors.push('min_cart_value is missing (a cart offer needs a minimum cart value; write 0 to apply it to every cart)')
    } else if (!Number.isFinite(minCartValue) || minCartValue < 0) {
      errors.push(`min_cart_value must be a rupee amount (got "${str(minRaw)}")`)
    }
  } else if (SCOPES.includes(scope)) {
    if (!appliesTo) errors.push(`applies_to must name the ${scope} this rule is for`)
    minCartValue = 0
  }

  if (errors.length) return { rule: null, errors }
  return {
    rule: { ruleId, scope, appliesTo, type, value, stackable, minCartValue },
    errors,
  }
}

/** Validates a raw cart item. Returns { item, errors }. */
export function validateCartItem(raw) {
  const errors = []
  const itemId = str(raw.itemId ?? raw.item_id)
  const product = str(raw.product)
  const brand = str(raw.brand)
  const platform = str(raw.platform)
  const priceRaw = raw.basePrice ?? raw.base_price
  const basePrice = parseRupees(priceRaw)

  const missing = []
  if (!itemId) missing.push('item_id')
  if (!product) missing.push('product')
  if (!brand) missing.push('brand')
  if (!platform) missing.push('platform')
  if (str(priceRaw) === '') missing.push('base price')
  if (missing.length) errors.push(`missing ${missing.join(', ')}`)
  else if (!Number.isFinite(basePrice) || basePrice <= 0) {
    errors.push(`base price must be a positive rupee amount (got "${str(priceRaw)}")`)
  } else if (basePrice > MAX_RUPEES) {
    errors.push(`base price is too large (got "${str(priceRaw)}")`)
  }

  if (errors.length) return { item: null, errors }
  return { item: { itemId, product, brand, platform, basePrice: Math.round(basePrice) }, errors }
}

/** Next free id in a RULE-NN / ITEM-NN sequence. */
export function nextId(prefix, existingIds) {
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i')
  const max = existingIds.reduce((m, id) => {
    const match = re.exec(id)
    return match ? Math.max(m, parseInt(match[1], 10)) : m
  }, 0)
  return `${prefix}-${String(max + 1).padStart(2, '0')}`
}
