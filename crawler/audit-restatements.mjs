// Restatement audit (Bonus 2 verification).
//
// For every period covered by more than one annual report, compare what each report
// says for that period. The compiled table uses the NEWEST report's value; this script
// prints every cell whose value actually CHANGED across reports, so you can confirm the
// newest value was used and eyeball real restatements against the PDFs.
//
//   node audit-restatements.mjs <slug> <income|balance|cashflow>
//   node audit-restatements.mjs novonordisk income
//
// Expense-sign noise (an old report transcribing a cost as +x instead of -x) is normalised
// away so it isn't mistaken for a restatement — the same rule compile() applies.

import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, "cache")
const slug = process.argv[2] || "novonordisk"
const kind = process.argv[3] || "income"

const yearOf = (p) => {
  const m = String(p).match(/(?:19|20)\d{2}/)
  return m ? +m[0] : null
}
const KEY_ALIASES = { revenues: "revenue", "total revenue": "revenue", "total revenues": "revenue" }
const canonKey = (label) => {
  const k = label.toLowerCase()
    .replace(/\([a-z]?\.?\d+\)/g, " ")
    .replace(/\((loss|profit|gain|income|expense|net)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([a-z])\d+\b/g, "$1")
    .replace(/\b(generated (from|by)|provided by|used (in|for)|flows? from)\b/g, "from")
    .replace(/ for the (financial )?(year|period)\b/g, "")
    .replace(/\s+/g, " ").trim()
  return KEY_ALIASES[k] ?? (k || label.trim().toLowerCase())
}
const isExpenseRow = (label) => {
  const l = label.toLowerCase()
  if (/income/.test(l) && /expenses?/.test(l)) return false
  if (/income tax/.test(l)) return true
  if (/\b(revenue|profit|gross|income)\b/.test(l)) return false
  return /\b(costs?|expenses?)\b/.test(l)
}
// Nth occurrence of a label within a statement gets a distinct key (IFRS repeats
// "Borrowings", "Provisions" under both non-current and current liabilities).
const rowKeys = (s) => {
  const c = new Map()
  return s.rows.map((r) => {
    const b = canonKey(r.label)
    const n = c.get(b) ?? 0
    c.set(b, n + 1)
    return n === 0 ? b : `${b}#${n}`
  })
}

const years = readdirSync(CACHE)
  .map((f) => f.match(new RegExp(`^${slug}-(\\d{4})\\.extracted\\.json$`)))
  .filter(Boolean).map((m) => +m[1]).sort((a, b) => b - a)
if (!years.length) {
  console.error(`no cache found for slug "${slug}" in ${CACHE}`)
  process.exit(1)
}

const rows = new Map() // key -> { label, byPeriod: Map(periodYear -> [{ report, value }]) }
for (const ry of years) {
  const s = JSON.parse(readFileSync(join(CACHE, `${slug}-${ry}.extracted.json`)))[kind]
  const keys = rowKeys(s)
  s.rows.forEach((r, i) => {
    const key = keys[i]
    if (!rows.has(key)) rows.set(key, { label: r.label, byPeriod: new Map() })
    const norm = (v) => (isExpenseRow(r.label) && v != null && v > 0 ? -v : v)
    s.periods.forEach((p, c) => {
      const py = yearOf(p)
      const v = norm(r.values?.[c] ?? null)
      if (py == null || v == null) return
      const bp = rows.get(key).byPeriod
      if (!bp.has(py)) bp.set(py, [])
      bp.get(py).push({ report: ry, value: v })
    })
  })
}

let n = 0
for (const [, { label, byPeriod }] of rows) {
  for (const [py, arr] of [...byPeriod.entries()].sort((a, b) => b[0] - a[0])) {
    if (arr.length < 2 || new Set(arr.map((a) => a.value)).size === 1) continue
    arr.sort((a, b) => b.report - a.report) // newest report first
    const used = arr[0], orig = arr[arr.length - 1]
    n++
    console.log(
      `${label} | ${py}:  used ${used.value} (${used.report} report)  <-  was ${orig.value} (${orig.report} report)   ` +
        `[${arr.map((a) => `${a.report}:${a.value}`).join(", ")}]`
    )
  }
}
console.log(`\n${n} restated cell(s) in ${slug} ${kind} — value changed across reports; newest used.`)
