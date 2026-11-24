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

/** Finds where each header column starts. Returns null if this isn't the header line. */
function headerColumns(line) {
  const lower = line.text.toLowerCase()
  if (!HEADERS.every((h) => lower.includes(h))) return null
  const starts = []
  for (const h of HEADERS) {
    const first = h.split(' ')[0]
    const run = line.runs.find((r) => r.str.trim().toLowerCase().startsWith(first))
    if (!run) return { starts: null } // header is one merged run: use text splitting
    starts.push(run.x)
  }
  const ascending = starts.every((x, i) => i === 0 || x > starts[i - 1])
  return { starts: ascending ? starts : null }
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

  const headerIdx = lines.findIndex((l) => headerColumns(l))
  if (headerIdx === -1) {
    return {
      items: [],
      errors: ['Could not find the table header. The PDF needs columns named Product, Brand, Platform and Base Price.'],
      meta: {},
    }
  }

  const { starts } = headerColumns(lines[headerIdx])
  const meta = { heading: lines.slice(0, headerIdx).map((l) => l.text).join(' · ') }
  const items = []
  const errors = []

  let rowNo = 0
  lines.slice(headerIdx + 1).forEach((line) => {
    if (isRule(line.text) || headerColumns(line)) return // separators, repeated headers on page 2+
    if (isFooter(line.text)) return
    rowNo += 1

    const positional = starts ? splitByPosition(line, starts) : []
    let cells = positional
    if (cells.filter(Boolean).length !== 4) cells = splitByText(line)

    if (cells.length !== 4) {
      // Column positions tell us exactly which value is missing; say so.
      const missing = positional.length
        ? positional.map((c, k) => (c ? null : COLUMN_NAMES[k])).filter(Boolean)
        : []
      errors.push(
        `Row ${rowNo} skipped ("${line.text}"): ` +
        (missing.length ? `missing ${missing.join(', ')}` : `expected 4 columns (Product, Brand, Platform, Base Price) but found ${cells.length}`)
      )
      return
    }

    const [product, brand, platform, basePrice] = cells
    const itemId = `ITEM-${String(items.length + 1).padStart(2, '0')}`
    const { item, errors: rowErrors } = validateCartItem({ itemId, product, brand, platform, basePrice })
    if (item) items.push(item)
    else errors.push(`Row ${rowNo} skipped ("${line.text}"): ${rowErrors.join('; ')}`)
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
      runs.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: p })
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
