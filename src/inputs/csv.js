/**
 * csv.js — CSV input adapter.
 *
 * Turns raw CSV text into DiscountRule[] / CartItem[] using the shared
 * validators in engine/models.js. Bad rows are reported and skipped; good rows
 * still load.
 *
 * rules.csv: rule_id, scope, applies_to, type, value, stackable, min_cart_value
 * cart.csv:  item_id, product, brand, platform, base_price
 */

import Papa from 'papaparse'
import { validateRule, validateCartItem } from '../engine/models.js'

function parseRows(csvText) {
  const { data, errors } = Papa.parse(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })
  // Field-count mismatches are reported per row below; only fatal errors stop the parse.
  const fatal = errors.filter((e) => e.type !== 'FieldMismatch')
  return { rows: data, fatal: fatal.map((e) => e.message) }
}

function collect(csvText, validate, key) {
  const { rows, fatal } = parseRows(csvText)
  if (fatal.length) return { data: [], errors: fatal }
  const data = []
  const errors = []
  rows.forEach((row, i) => {
    const result = validate(row)
    if (result[key]) data.push(result[key])
    else errors.push(`Row ${i + 2} skipped: ${result.errors.join('; ')}`)
  })
  return { data, errors }
}

export function parseRulesCSV(csvText) {
  return collect(csvText, validateRule, 'rule')
}

export function parseCartCSV(csvText) {
  return collect(csvText, validateCartItem, 'item')
}
