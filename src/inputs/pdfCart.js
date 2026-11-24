/**
 * pdfCart.js — PDF cart input adapter.
 *
 * Reads a cart PDF laid out as a simple table:
 *
 *   Product        Brand          Platform       Base Price
 *   Cushion Cover  Natura Casa    Amazon India   Rs.1,299
 *
 * and returns CartItem[] through the same validator the CSV adapter uses.
 *
 * Approach: pull positioned text runs out of the PDF with pdf.js, group runs
 * into lines by their y position, find the header line, and use the x position
 * where each header word starts as the column boundaries. Every row below the
 * header is split into cells by those boundaries. If a row can't be split that
 * way (e.g. the PDF stored the row as one text run), we fall back to splitting
 * on runs of 2+ spaces, tabs or pipes.
 *
 * A row that still doesn't give four cells, or whose price isn't a number, is
 * skipped and reported to the user by line, never silently dropped and never
 * allowed to abort the whole upload.
 */

import { validateCartItem } from '../engine/models.js'

const HEADERS = ['product', 'brand', 'platform', 'base price']
const COLUMN_NAMES = ['Product', 'Brand', 'Platform', 'Base Price']
const LINE_TOLERANCE = 3 // pt: runs whose baselines differ by less than this are one line
const COLUMN_SLACK = 6 // pt: a cell may start slightly left of its header

/** Groups positioned text runs into lines, top of page first. */
export function groupIntoLines(runs) {
  const sorted = runs
    .filter((r) => r.str && r.str.trim())
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const lines = []
  for (const run of sorted) {
    const line = lines.find((l) => l.page === run.page && Math.abs(l.y - run.y) < LINE_TOLERANCE)
    if (line) line.runs.push(run)
    else lines.push({ page: run.page, y: run.y, runs: [run] })
  }
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x)
    line.text = line.runs.map((r) => r.str).join(' ').replace(/\s+/g, ' ').trim()
  }
  return lines
}

const HEADER_FRAGMENT = /^(base|price|base price|\(?(rs\.?|inr|₹)\)?)$/i
const lineHeight = (line) => Math.max(...line.runs.map((r) => r.h || 10))
const hasHeaderWords = (line) => ['product', 'brand', 'platform'].every((w) => line.text.toLowerCase().includes(w))
const isHeaderFragment = (line) => line.runs.every((r) => !r.str.trim() || HEADER_FRAGMENT.test(r.str.trim()))

/**
 * Finds the header and where each column starts. In a narrow table the header
 * itself can wrap ("Base" on one line, "Price" on the next), so lines right
 * above or below that hold only header fragments are folded in.
 * Returns { first, last, starts } (starts is null when positions are unusable) or null.
 */
function findHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!hasHeaderWords(lines[i])) continue
    const group = [i]
    for (const j of [i - 1, i + 1]) {
      const near = lines[j] && lines[j].page === lines[i].page &&
        Math.abs(lines[j].y - lines[i].y) < 2 * lineHeight(lines[i])
      if (near && isHeaderFragment(lines[j])) group.push(j)
    }
    const runs = group.flatMap((k) => lines[k].runs)
    if (!/price/i.test(runs.map((r) => r.str).join(' '))) continue
    const startOf = (re) => {
      const xs = runs.filter((r) => re.test(r.str.trim().toLowerCase())).map((r) => r.x)
      return xs.length ? Math.min(...xs) : null
    }
    let starts = [startOf(/^product/), startOf(/^brand/), startOf(/^platform/), startOf(/^(base|price)/)]
    // One merged header run, or columns out of order: fall back to text splitting.
    if (starts.some((x) => x === null) || !starts.every((x, k) => k === 0 || x > starts[k - 1])) starts = null
    return { first: Math.min(...group), last: Math.max(...group), starts }
  }
  return null
}

/**
 * A product name that wraps inside its cell shows up as extra lines holding
 * parts of some columns and no price. Fold each such line into the nearest
 * priced row if it sits within a wrapped line's distance (1.6 line heights).
 * Separate table rows sit further apart than that, so a row that is really
 * missing its price stays its own row and is still reported, not merged.
 */
function foldWrappedLines(rows) {
  const anchors = rows.filter((r) => r.cells[3])
  const kept = []
  for (const row of rows) {
    if (row.cells[3] || !row.cells.some(Boolean)) { kept.push(row); continue }
    const limit = 1.6 * lineHeight(row.line)
    const anchor = anchors
      .filter((a) => a.line.page === row.line.page && Math.abs(a.line.y - row.line.y) <= limit)
      .sort((a, b) => Math.abs(a.line.y - row.line.y) - Math.abs(b.line.y - row.line.y))[0]
    if (!anchor) { kept.push(row); continue }
    const above = row.line.y > anchor.line.y
    anchor.cells = anchor.cells.map((c, k) =>
      !row.cells[k] ? c : above ? `${row.cells[k]} ${c}`.trim() : `${c} ${row.cells[k]}`.trim())
    anchor.text = above ? `${row.line.text} ${anchor.text}` : `${anchor.text} ${row.line.text}`
  }
  return kept
}

function splitByPosition(line, starts) {
  const cells = ['', '', '', '']
  for (const run of line.runs) {
    let col = 0
    for (let i = 0; i < starts.length; i++) if (run.x >= starts[i] - COLUMN_SLACK) col = i
    cells[col] = `${cells[col]} ${run.str}`.trim()
  }
  return cells.map((c) => c.replace(/\s+/g, ' '))
}

function splitByText(line) {
  const raw = line.runs.map((r) => r.str).join('  ')
  return raw.split(/\s*\|\s*|\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean)
}

const isRule = (text) => /^[\s\-─━_=|+.]+$/.test(text)
const isFooter = (text) => /^(sub)?total\b|^grand total\b|^page \d+/i.test(text)

/**
 * Pure step: positioned text runs → { items, errors, meta }.
 * Kept separate from pdf.js so it can be unit tested with plain objects.
 */
export function cartFromTextRuns(runs) {
  const lines = groupIntoLines(runs)
  if (lines.length === 0) {
    return {
      items: [],
      errors: ['This PDF has no readable text. It may be a scanned image; please upload a text-based PDF or the CSV.'],
      meta: {},
    }
  }

  const header = findHeader(lines)
  if (!header) {
    return {
      items: [],
      errors: ['Could not find the table header. The PDF needs columns named Product, Brand, Platform and Base Price.'],
      meta: {},
    }
  }

  const { starts } = header
  const meta = { heading: lines.slice(0, header.first).map((l) => l.text).join(' · ') }
  const items = []
  const errors = []

  let rows = lines
    .slice(header.last + 1)
    // separators, footers, and headers repeated on page 2+
    .filter((l) => !isRule(l.text) && !isFooter(l.text) && !hasHeaderWords(l) && !isHeaderFragment(l))
    .map((line) => ({ line, text: line.text, cells: starts ? splitByPosition(line, starts) : [] }))
  if (starts) rows = foldWrappedLines(rows)

  rows.forEach(({ line, text, cells: positional }, i) => {
    const rowNo = i + 1
    let cells = positional
    if (cells.filter(Boolean).length !== 4) cells = splitByText(line)

    if (cells.length !== 4) {
      // Column positions tell us exactly which value is missing; say so.
      const missing = positional.length
        ? positional.map((c, k) => (c ? null : COLUMN_NAMES[k])).filter(Boolean)
        : []
      errors.push(
        `Row ${rowNo} skipped ("${text}"): ` +
        (missing.length ? `missing ${missing.join(', ')}` : `expected 4 columns (Product, Brand, Platform, Base Price) but found ${cells.length}`)
      )
      return
    }

    const [product, brand, platform, basePrice] = cells
    const itemId = `ITEM-${String(items.length + 1).padStart(2, '0')}`
    const { item, errors: rowErrors } = validateCartItem({ itemId, product, brand, platform, basePrice })
    if (item) items.push(item)
    else errors.push(`Row ${rowNo} skipped ("${text}"): ${rowErrors.join('; ')}`)
  })

  if (items.length === 0 && errors.length === 0) {
    errors.push('The table header was found but there were no item rows under it.')
  }
  return { items, errors, meta }
}

/** Extracts positioned text runs from every page using a pdf.js instance. */
export async function textRunsFromPdf(data, pdfjs) {
  const doc = await pdfjs.getDocument({ data }).promise
  const runs = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!('str' in it)) continue
      runs.push({ str: it.str, x: it.transform[4], y: it.transform[5], h: Math.hypot(it.transform[2], it.transform[3]), page: p })
    }
  }
  return runs
}

/** Browser entry point: File/ArrayBuffer → { items, errors, meta }. */
export async function parseCartPDF(arrayBuffer) {
  let runs
  try {
    const pdfjs = await import('pdfjs-dist')
    const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    runs = await textRunsFromPdf(new Uint8Array(arrayBuffer), pdfjs)
  } catch (err) {
    return { items: [], errors: [`Could not read this file as a PDF (${err.message}).`], meta: {} }
  }
  return cartFromTextRuns(runs)
}
