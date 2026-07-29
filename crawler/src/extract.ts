/*
 * Turn a company's annual reports into the three financial statements the
 * dashboard shows (Income Statement, Balance Sheet, Cash Flow).
 *
 * Pipeline (top to bottom):
 *
 *   1. download the PDF (cached on disk)               downloadPdf / ensurePdf
 *   2. split it into per-page text (cached on disk)    loadPages
 *   3. strip repeated boilerplate + build a heading map  stripBoilerplate (no LLM)
 *   4. LLM locates income/balance/cashflow pages         locateStatements (1 call)
 *   5. LLM transcribes each statement's table            extractStatement (3 calls)
 *   6. merge years, validate, write the file             compile / validate / write
 *
 * Everything except steps 4 and 5 is plain code. The cache (step 1-2) means that
 * while you tune the prompts you re-run against local files, not the IR website.
 * The extracted statements (steps 4-5) are cached too, so re-running a company you
 * already pulled costs zero LLM calls — use --refresh to re-extract from scratch.
 *
 *   npm run extract                       extract SAP (default), write lib/data/sap.ts
 *   npm run extract -- --company nvo       another company from the registry
 *   npm run extract -- --check             just test the API key
 *   npm run extract -- --years 2015-2025
 *   npm run extract -- --refresh           ignore the cache and re-download/re-parse
 *   npm run extract -- --dry-run           extract + check totals, don't write
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import OpenAI from "openai"
import { extractText, getDocumentProxy } from "unpdf"
import { makeClient, resolveProvider } from "./discover.js"

// ─── CONFIG — the company registry ────────────────────────────────────────
// `pdf` is either a function (predictable URL) or an explicit {year: url} map
// (for sites with no pattern). To add a company, add an entry here — no other
// code changes. Later, the discovery agent will fill these in automatically.
type PdfSource = ((year: number) => string) | Record<number, string>
interface Company {
  name: string
  years: number[]
  pdf: PdfSource
}

// Optional overrides for companies whose PDF URL is known/stable — lets extract skip
// discovery for them (faster, no LLM). Empty = every company goes through discovery,
// and the found URLs are cached in cache/discovered.json. You can also pre-seed that
// cache file with known URLs instead of hardcoding them here.
const COMPANIES: Record<string, Company> = {}

// Both are set from --company in main(); every code path that reads them runs after.
let SLUG: string
let COMPANY: Company
// Optional --pages override (escape hatch): pins statement page indices, skips the locator.
let PAGES_OVERRIDE: Partial<Record<Kind, number>> = {}

// The PDF URL from the registry (function or map), or the discovery cache.
function registeredUrl(year: number): string | undefined {
  const src = COMPANY.pdf
  return (
    (typeof src === "function" ? src(year) : src[year]) ?? discoveredUrl(year)
  )
}

// Resolve the PDF URL. Registry/cache first; on a miss, run the discovery agent
// (which caches its result). This is what lets the registry be optional — an
// unregistered company just triggers discovery.
async function ensurePdfUrl(year: number): Promise<string> {
  const known = registeredUrl(year)
  if (known) return known
  console.log(`  no URL for ${SLUG} ${year} — running discovery agent…`)
  const { discoverPdfUrl } = await import("./discover.js")
  const found = await discoverPdfUrl(COMPANY.name, year, SLUG)
  if (found) return found
  // Throw (not fail/exit) so a single missing year is skipped, not the whole run.
  throw new Error(`no official PDF found for ${SLUG} ${year}`)
}

// URLs found by the discovery agent (crawler/cache/discovered.json). This is the
// cache the agent fills, so a registry miss is served from here on the next run.
function discoveredUrl(year: number): string | undefined {
  const file = join(CACHE_DIR, "discovered.json")
  if (!existsSync(file)) return undefined
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>)[
      `${SLUG}:${year}`
    ]
  } catch {
    return undefined
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(HERE, "..", "cache") // downloaded PDFs + parsed page text
const APP_DATA_DIR = join(HERE, "..", "..", "lib", "data") // fiscal.ai/lib/data
let MODEL = "gpt-4o" // resolved from env in main()
const MAX_YEARS = 10 // the compiled view keeps the most recent N years

// ─── Types (mirror the app's lib/types.ts) ────────────────────────────────
type RowKind = "section" | "line" | "subtotal" | "total"
interface Row {
  label: string
  kind: RowKind
  unit?: "currency" | "shares"
  decimals?: number
  values: (number | null)[]
  restatedIndices?: number[]
}
interface Statement {
  periods: string[]
  rows: Row[]
}
type Kind = "income" | "balance" | "cashflow"
const KINDS: Kind[] = ["income", "balance", "cashflow"]

// ─── 1. Download the PDF (cached) ─────────────────────────────────────────
async function ensurePdf(
  year: number,
  url: string,
  refresh: boolean
): Promise<Uint8Array> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${SLUG}-${year}.pdf`)

  if (!refresh && existsSync(file)) return new Uint8Array(readFileSync(file))

  console.log(`  downloading ${year} — ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  writeFileSync(file, bytes)
  return bytes
}

// ─── 2. Split into per-page text (cached) ─────────────────────────────────
async function loadPages(year: number, refresh: boolean): Promise<string[]> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${SLUG}-${year}.pages.json`)

  if (!refresh && existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf-8")).pages as string[] // cached — no URL needed
  }

  // Only now, when we actually have to download, do we resolve the URL
  // (registry → cache → discovery). Cached runs never touch discovery.
  const url = await ensurePdfUrl(year)
  const bytes = await ensurePdf(year, url, refresh)
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: false }) // one string per page
  const pages = Array.isArray(text) ? text : [text]
  writeFileSync(file, JSON.stringify({ year, pages }))
  console.log(`  ${year}: ${pages.length} pages parsed`)
  return pages
}

// ─── 3. Keyword pre-filter to candidate pages (no LLM) ────────────────────
// A statement's title/line-items are standard accounting terms, so this narrows
// hundreds of pages to a handful before we spend any LLM calls.
// Standard statement titles across IFRS and US GAAP (SAP, Novo, ASML all differ).
const HEADINGS: Record<Kind, string[]> = {
  income: [
    "income statement",
    "statement of operations",
    "statement of profit or loss",
    "profit and loss",
  ],
  balance: ["statement of financial position", "balance sheet"],
  cashflow: [
    "statement of cash flows",
    "cash flow statement",
    "statements of cash flows",
  ],
}
// Line items that, in the real table, sit next to a number. Multi-word so they
// don't match narrative text. Covers IFRS ("revenue", "profit after tax") and
// US GAAP ("net sales", "net income").
const CONFIRM: Record<Kind, string[]> = {
  income: [
    "net sales",
    "total revenue",
    "gross profit",
    "operating profit",
    "operating income",
    "profit before tax",
    "profit after tax",
    "net income",
    "cost of sales",
    "cost of revenue",
  ],
  balance: [
    "total assets",
    "total equity",
    "total liabilities",
    "total current assets",
    "total non-current assets",
  ],
  cashflow: [
    "operating activities",
    "investing activities",
    "financing activities",
    "net cash",
  ],
}
// Parent-company / standalone statements (local GAAP or separate financial statements)
// are NOT the consolidated group figures we want, and Notes / accounting-policy pages are
// prose rather than the statement table. A page carrying either marker is disqualified as a
// candidate — the "consolidated section" filter, by page CONTENT not fragile TOC page numbers.
// NOTE: we deliberately do NOT match "notes to ... financial statements" here — that phrase
// also appears in the FOOTER of the real statement pages, so it would wrongly drop them.
const STANDALONE_MARKERS = [
  "separate financial statements",
  "parent company financial statements",
  "company financial statements",
  "stand-alone financial statements",
  "standalone financial statements",
  "individual financial statements",
  "unconsolidated financial statements",
]
const NOTES_MARKERS = ["significant accounting policies"]
function pageScore(pageLower: string, kind: Kind): number {
  if (STANDALONE_MARKERS.some((m) => pageLower.includes(m))) return 0
  if (NOTES_MARKERS.some((m) => pageLower.includes(m))) return 0
  let score = 0
  for (const heading of HEADINGS[kind])
    if (pageLower.includes(heading)) score += 5
  for (const anchor of CONFIRM[kind]) {
    let i = pageLower.indexOf(anchor)
    while (i !== -1) {
      if (
        /\d{2,}/.test(
          pageLower.slice(i + anchor.length, i + anchor.length + 40)
        )
      ) {
        score += 1
        break
      }
      i = pageLower.indexOf(anchor, i + 1)
    }
  }
  return score
}

// Returns, per kind, the candidate page indices (best first), plus the union.
function candidatePages(pages: string[]): {
  byKind: Record<Kind, number[]>
  union: number[]
} {
  const lower = pages.map((p) => p.toLowerCase())
  const byKind = { income: [], balance: [], cashflow: [] } as Record<
    Kind,
    number[]
  >
  const union = new Set<number>()

  for (const kind of KINDS) {
    const scored = lower
      .map((p, index) => ({ index, score: pageScore(p, kind) }))
      .filter((c) => c.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    byKind[kind] = scored.map((c) => c.index)
    for (const c of scored) union.add(c.index)
  }
  return { byKind, union: [...union].sort((a, b) => a - b) }
}

// Cheap English-language check (no LLM): English prose is dense with a handful of
// stopwords; other languages are not. Used to keep non-English reports out of scope
// before we spend LLM tokens on them. Lenient — only blocks clearly non-English text.
function looksEnglish(pages: string[]): boolean {
  const sample = pages.slice(0, 30).join(" ").toLowerCase()
  const words = sample.match(/[a-z]+/g) ?? []
  if (words.length < 200) return true // too little text to judge — don't block
  const common = new Set([
    "the",
    "and",
    "of",
    "to",
    "in",
    "for",
    "as",
    "are",
    "with",
    "that",
    "this",
    "total",
    "cash",
    "income",
    "assets",
    "from",
    "other",
  ])
  const hits = words.filter((w) => common.has(w)).length
  return hits / words.length > 0.05
}

// ─── 3b. Strip repeated boilerplate (running headers, footers, side nav) ──
// Some reports print a full section navigation on EVERY page, so a keyword search
// finds the statement titles everywhere. Segments that repeat on many pages are
// boilerplate; removing them leaves each page's real content. Used only for LOCATING
// (extraction still runs on the original page text).
function stripBoilerplate(pages: string[]): string[] {
  const split = (p: string) =>
    p.split(/[\n\r]| {2,}| › |\|/).map((s) => s.trim())
  const freq = new Map<string, number>()
  for (const p of pages) {
    for (const s of new Set(split(p))) {
      if (s.length >= 4) freq.set(s, (freq.get(s) ?? 0) + 1)
    }
  }
  const boiler = new Set(
    [...freq].filter(([, c]) => c > pages.length * 0.25).map(([s]) => s)
  )
  return pages.map((p) =>
    split(p)
      .filter((s) => !boiler.has(s))
      .join(" ")
  )
}

// ─── 3c. Statement locator (LLM, ONE call): which page is each statement? ──
// The three primary statements sit together in the "Consolidated Financial Statements"
// section, just before the notes. We hand the LLM a MAP of the report's statement/section
// headings (page index → heading, from the boilerplate-stripped text) and it returns each
// statement's page directly. A whole-document map — not a hand-tuned keyword list — is what
// generalizes across layouts (a management report full of the same figures no longer fools
// it), and doing section + statement location in ONE call keeps token use low.
const LANDMARKS = [
  "consolidated income statement",
  "consolidated statement of",
  "income statement",
  "balance sheet",
  "statement of financial position",
  "statement of cash flows",
  "cash flow statement",
  "statement of comprehensive income",
  "statement of changes in equity",
  "notes to the consolidated",
  "notes to the financial",
  "independent auditor",
  "statutory auditor",
]
function headingMap(cleaned: string[]): { i: number; head: string }[] {
  const map: { i: number; head: string }[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const flat = cleaned[i].replace(/\s+/g, " ").trim()
    if (LANDMARKS.some((m) => flat.toLowerCase().includes(m))) {
      map.push({ i, head: flat.slice(0, 110) })
    }
  }
  return map
}

async function locateStatements(
  client: OpenAI,
  cleaned: string[]
): Promise<Record<Kind, number | null>> {
  const none: Record<Kind, number | null> = {
    income: null,
    balance: null,
    cashflow: null,
  }
  const map = headingMap(cleaned)
  if (map.length === 0) return none

  const res = await chat(client, {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Below is a MAP of an annual report: a page index and the statement/section heading on\n" +
          "each listed page. Return the page index whose TABLE is each PRIMARY CONSOLIDATED statement:\n" +
          "  income   = Consolidated Income Statement / Statement of Operations / Profit and Loss\n" +
          "  balance  = Consolidated Balance Sheet / Statement of Financial Position\n" +
          "  cashflow = Consolidated Statement of Cash Flows\n" +
          "The three sit together, just before 'Notes to the consolidated financial statements'.\n" +
          "Choose the CONSOLIDATED GROUP statement. Return null for a kind rather than pick:\n" +
          "  - a contents/index page that merely LISTS all three statements,\n" +
          "  - parent-company / standalone / separate statements (local GAAP, e.g. HGB),\n" +
          "  - comprehensive income, changes in equity, notes, or the auditor's report.\n" +
          'Return ONLY JSON: { "income": <index or null>, "balance": <index or null>, "cashflow": <index or null> }',
      },
      { role: "user", content: map.map((m) => `p${m.i}: ${m.head}`).join("\n") },
    ],
  })
  const parsed = parseJson(res)
  const valid = new Set(map.map((m) => m.i))
  const pick = (v: unknown) => (typeof v === "number" && valid.has(v) ? v : null)
  return {
    income: pick(parsed.income),
    balance: pick(parsed.balance),
    cashflow: pick(parsed.cashflow),
  }
}

// One chat call, with backoff on rate limits (429) and transient server errors.
interface ChatParams {
  model: string
  max_tokens?: number
  messages: { role: "system" | "user"; content: string }[]
}
async function chat(client: OpenAI, params: ChatParams): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.chat.completions.create(params)
      return res.choices[0].message.content ?? ""
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0
      const retryable = status === 429 || (status >= 500 && status < 600)
      if (!retryable || attempt >= 5) throw err
      const waitMs = Math.min(30_000, 1000 * 2 ** attempt)
      console.warn(
        `    rate-limited (${status}) — retrying in ${waitMs / 1000}s…`
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

// ─── 5. LLM table extractor: transcribe one page's table into rows ────────
const TRANSCRIBE =
  "You transcribe a company's financial statement from filing text into JSON.\n" +
  "Return ONLY a JSON object (no prose) of this shape:\n" +
  '{ "periods": string[], "rows": [ { "label": string, ' +
  '"kind": "section"|"line"|"subtotal"|"total", "values": (number|null)[], ' +
  '"unit"?: "currency"|"shares", "decimals"?: number } ] }\n' +
  "Keep every line item in order. `periods` are the column headers left-to-right. " +
  "Numbers in the reporting unit (usually millions); negatives negative; blanks null. " +
  "IGNORE any 'Note'/reference column — the column of note cross-references that sits BETWEEN " +
  "the line-item label and the year value columns (e.g. 4.3, '4.3, 4.5', (D.2), (A.1), 'Note 12'). " +
  "These point to notes, they are NOT data. Transcribe ONLY the value columns under the period " +
  "headers. Every row's `values` MUST have exactly one entry per period (same length as " +
  "`periods`), left-to-right; use null for a blank or '—' cell so columns never shift. " +
  "kind 'section' = header row with no numbers, 'line' = a line item, " +
  "'subtotal'/'total' = summed rows. unit:'shares' for share counts, decimals:2 for per-share rows."

async function extractStatement(
  client: OpenAI,
  pageText: string,
  kind: Kind
): Promise<Statement> {
  const res = await chat(client, {
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: "system", content: TRANSCRIBE },
      {
        role: "user",
        content: `This is the ${kind} statement. Return the JSON:\n\n${pageText.slice(0, 12000)}`,
      },
    ],
  })
  const parsed = parseJson(res)
  const periods = Array.isArray(parsed.periods) ? parsed.periods : []
  // Sanitize: the model occasionally omits fields — keep only well-formed rows and make
  // sure every row has a values array, so compile/validation never hit an undefined.
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter((r): r is Row => !!r && typeof r.label === "string")
    .map((r) => ({ ...r, values: Array.isArray(r.values) ? r.values : [] }))

  // Safety net: every row must carry exactly one value per period. A different count means the
  // model dropped or added a cell — i.e. a silent column shift. Flag those rows and normalise
  // the length (pad right with null / truncate) so a miscount can never misalign the compile.
  const P = periods.length
  if (P > 0) {
    let flagged = 0
    for (const r of rows) {
      if (r.kind === "section") continue // headers legitimately carry no values
      if (r.values.length === P) continue
      flagged++
      console.warn(
        `    ⚠ ${kind}: "${r.label}" returned ${r.values.length} values for ${P} periods — check for a column shift`
      )
      r.values =
        r.values.length < P
          ? [...r.values, ...Array(P - r.values.length).fill(null)]
          : r.values.slice(0, P)
    }
    if (flagged)
      console.warn(`    ⚠ ${kind}: ${flagged} row(s) had a value/period count mismatch`)
  }
  return { periods, rows }
}

function parseJson(content: string): {
  periods?: string[]
  rows?: Row[]
  [k: string]: unknown
} {
  let s = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim()
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ─── 6. Merge across years, then sanity-check the totals ──────────────────
// Companies rename the same line item across years — Novo's bottom line is
// "Net profit" vs "Net profit for the year"; LVMH's JV line is "Income (loss)…" vs
// "Income/(loss)…" vs "Income/(Loss)…". We match rows by a NORMALISED KEY (lowercase,
// punctuation-stripped, "for the year/period" removed) so those variants collapse onto
// ONE row — while the DISPLAY label keeps the newest report's wording (see compile).
// A few line items are the same figure under different names across years — most
// commonly the top line (Airbus: "Revenues" → "Revenue"). Map known aliases onto one
// canonical key so those columns merge instead of splitting into half-filled rows.
const KEY_ALIASES: Record<string, string> = {
  revenues: "revenue",
  "total revenue": "revenue",
  "total revenues": "revenue",
}
function canonKey(label: string): string {
  const k = label
    .toLowerCase()
    // note/footnote refs in parens: "(3)", "(D.2)", "(b.3)", "(e.2)"
    .replace(/\([a-z]?\.?\d+\)/g, " ")
    // wording that only appears in loss/gain years, e.g. "Profit (loss) after tax"
    .replace(/\((loss|profit|gain|income|expense|net)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    // trailing footnote digit stuck to a word: "tax1" → "tax", "refunds2" → "refunds"
    .replace(/([a-z])\d+\b/g, "$1")
    // cash-flow subtotals drift in wording: "generated from" / "flows from" / "used in" all
    // mean the same, so "net cash generated from operating" == "net cash flows from operating".
    .replace(/\b(generated (from|by)|provided by|used (in|for)|flows? from)\b/g, "from")
    .replace(/ for the (financial )?(year|period)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return KEY_ALIASES[k] ?? (k || label.trim().toLowerCase())
}

// Clean a label for DISPLAY only: strip note cross-references — "(D.2)", "(A.1), (C.2)" — and
// footnote superscripts that clutter the table (SAP's 20-F is full of them). Row MERGING still
// uses canonKey; this only prettifies what the dashboard shows.
function cleanLabel(label: string): string {
  return label
    .replace(/[\s,]*\([A-Za-z]?\.?\d+\)/g, "")
    .replace(/([A-Za-z])\d+\b/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
}

// Some older reports come back with expense lines as positive magnitudes (the model dropped the
// parenthesis/minus that marks them negative). A pure-expense line is always negative in the
// statement, so we coerce any stray positive back to negative — restoring the as-reported sign.
// Net "income and expenses" lines and revenue/profit/income lines are excluded (they swing sign).
function isExpenseRow(label: string): boolean {
  const l = label.toLowerCase()
  if (/income/.test(l) && /expenses?/.test(l)) return false // net income-and-expense line
  if (/income tax/.test(l)) return true
  if (/\b(revenue|profit|gross|income)\b/.test(l)) return false
  return /\b(costs?|expenses?)\b/.test(l)
}

function compile(input: { year: number; statement: Statement }[]): Statement {
  const newestFirst = [...input].sort((a, b) => b.year - a.year)

  const labelByYear = new Map<number, string>()
  for (const { statement } of newestFirst) {
    for (const period of statement.periods) {
      const y = yearOf(period)
      if (y !== null && !labelByYear.has(y)) labelByYear.set(y, period)
    }
  }
  const years = [...labelByYear.keys()].sort((a, b) => b - a)
  // Display the fiscal year as the column header. Reports label the period inconsistently
  // ("2025-12-31", "12/31/2021", "2015 €", "2025³"), so normalise to the year for a clean table.
  const periods = years.map((y) => String(y))

  // Dedup by canonical key; the first row seen (newest report) becomes the display template.
  const labels: Row[] = []
  const seen = new Set<string>()
  for (const { statement } of newestFirst) {
    for (const row of statement.rows) {
      const key = canonKey(row.label)
      if (seen.has(key)) continue
      seen.add(key)
      labels.push(row)
    }
  }

  const rows = labels.map((template) => {
    const values: (number | null)[] = []
    const restated: number[] = []
    years.forEach((year, i) => {
      const reporting = newestFirst
        .map((r) => ({
          year: r.year,
          value: valueFor(r.statement, template.label, year),
        }))
        .filter((r) => r.value !== null)
      if (reporting.length === 0) return values.push(null)
      values.push(reporting[0].value)
      if (reporting[0].year !== reporting[reporting.length - 1].year)
        restated.push(i)
    })
    const row: Row = { label: cleanLabel(template.label), kind: template.kind, values }
    if (isExpenseRow(row.label))
      row.values = row.values.map((v) => (v != null && v > 0 ? -v : v))
    if (template.unit) row.unit = template.unit
    if (template.decimals != null) row.decimals = template.decimals
    if (restated.length) row.restatedIndices = restated
    return row
  })

  return { periods, rows }
}

function valueFor(
  statement: Statement,
  label: string,
  year: number
): number | null {
  const key = canonKey(label)
  const row = statement.rows.find((r) => canonKey(r.label) === key)
  if (!row) return null
  const col = statement.periods.findIndex((p) => yearOf(p) === year)
  return col === -1 ? null : (row.values?.[col] ?? null)
}

function yearOf(period: string): number | null {
  const m = period.match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

function reconcile(statement: Statement): string[] {
  const problems: string[] = []
  let lines: Row[] = []
  for (const row of statement.rows) {
    if (row.kind === "line") {
      lines.push(row)
    } else if (row.kind === "subtotal" || row.kind === "total") {
      statement.periods.forEach((period, i) => {
        const sum = lines.reduce((acc, l) => acc + (l.values?.[i] ?? 0), 0)
        const got = row.values?.[i]
        if (got != null && Math.abs(sum - got) > 1) {
          problems.push(
            `${row.label} @ ${period}: lines sum to ${Math.round(sum)}, row says ${got}`
          )
        }
      })
      lines = []
    } else {
      lines = []
    }
  }
  return problems
}

// ─── 6b. Cross-statement validation (accounting identities) ────────────────
// reconcile() checks structure WITHIN a statement (do the line items sum to the subtotal).
// validateStatements() checks identities ACROSS statements on the final merged data —
// this is deterministic maths, not the LLM. Three identities that hold for any IFRS/US-GAAP
// filer:
//   • FAIL   the balance sheet balances: Total assets = Total equity + Total liabilities
//   • FAIL   net profit is the same on the income statement and the cash-flow statement
//   • WARN   cash-flow ending cash = the balance sheet's cash line (reclassifications /
//            restricted cash mean this legitimately drifts, so it's a warning, not a fail)
type Severity = "fail" | "warning"
interface ValidationIssue {
  check: string
  severity: Severity
  period: string
  expected: number
  actual: number
  diff: number
}
interface ValidationResult {
  status: "pass" | "warning" | "fail"
  issues: ValidationIssue[]
}

// Net-profit line goes by many names across IFRS/US GAAP filers.
const NET_PROFIT_LABELS = new Set([
  "net profit",
  "net income",
  "profit for the year",
  "profit for the period",
  "profit after tax",
  "profit after taxes",
  "earnings after taxes",
  "consolidated net income",
])

// First matching row that actually HAS a value for the period — a label like "operating
// activities" matches a null section header AND the real total row, so we skip the nulls.
function findValue(
  st: Statement,
  period: string,
  match: (label: string) => boolean
): number | null {
  const col = st.periods.indexOf(period)
  if (col === -1) return null
  for (const row of st.rows) {
    const v = row.values?.[col]
    if (v != null && match(row.label.trim().toLowerCase())) return v
  }
  return null
}

function validateStatements(data: Record<Kind, Statement>): ValidationResult {
  const issues: ValidationIssue[] = []
  const off = (a: number, b: number) =>
    Math.abs(a - b) > Math.max(1, Math.abs(b) * 0.005)
  const add = (
    check: string,
    severity: Severity,
    period: string,
    expected: number,
    actual: number
  ) =>
    issues.push({
      check,
      severity,
      period,
      expected,
      actual,
      diff: actual - expected,
    })

  // 1. Balance sheet identity (FAIL).
  for (const period of data.balance.periods) {
    const assets = findValue(data.balance, period, (l) => l === "total assets")
    let eqLiab = findValue(data.balance, period, (l) =>
      /^total (equity and liabilities|liabilities and equity)$/.test(l)
    )
    if (eqLiab == null) {
      const eq = findValue(data.balance, period, (l) => l === "total equity")
      const liab = findValue(
        data.balance,
        period,
        (l) => l === "total liabilities"
      )
      if (eq != null && liab != null) eqLiab = eq + liab
    }
    if (assets != null && eqLiab != null && off(assets, eqLiab))
      add(
        "balance sheet balances (assets = equity + liabilities)",
        "fail",
        period,
        eqLiab,
        assets
      )
  }

  // 2. Net profit is the same on the income statement and the cash-flow statement (FAIL).
  const isNetProfit = (l: string) => NET_PROFIT_LABELS.has(l)
  for (const period of data.income.periods) {
    const inc = findValue(data.income, period, isNetProfit)
    const cf = findValue(data.cashflow, period, isNetProfit)
    if (inc != null && cf != null && off(inc, cf))
      add("net profit matches (income vs cash flow)", "fail", period, inc, cf)
  }

  // 3. Cash-flow ending cash = the balance sheet cash line (WARNING).
  const isBsCash = (l: string) =>
    l.includes("cash and cash equivalents") ||
    l.includes("cash at bank") ||
    l === "cash"
  const isEndingCash = (l: string) => l.includes("cash") && l.includes("end")
  for (const period of data.balance.periods) {
    const bs = findValue(data.balance, period, isBsCash)
    const cf = findValue(data.cashflow, period, isEndingCash)
    if (bs != null && cf != null && off(bs, cf))
      add(
        "ending cash matches (cash flow vs balance sheet)",
        "warning",
        period,
        bs,
        cf
      )
  }

  // 4. Coverage (per period): each statement must carry its headline line WITH A VALUE for
  //    every period. A missing figure means that year's page was wrong (e.g. a notes page) —
  //    something the identity checks alone miss (they skip when a label isn't found).
  const coverage: [Kind, RegExp, string][] = [
    // "sales" also covers Rheinmetall-style nature-of-expense statements ("Sales"),
    // "total operating performance", etc.; "revenue"/"turnover" cover the rest.
    [
      "income",
      /revenue|sales|turnover|total operating performance/,
      "income: no revenue/sales value (wrong page?)",
    ],
    [
      "balance",
      /^total assets$/,
      "balance: no total assets value (wrong page?)",
    ],
    [
      "cashflow",
      /operating activities/,
      "cashflow: no operating-activities value (wrong page?)",
    ],
  ]
  for (const [kind, re, msg] of coverage)
    for (const period of data[kind].periods)
      if (findValue(data[kind], period, (l) => re.test(l)) == null)
        issues.push({
          check: msg,
          severity: "fail",
          period,
          expected: 0,
          actual: 0,
          diff: 0,
        })

  const status = issues.some((i) => i.severity === "fail")
    ? "fail"
    : issues.length
      ? "warning"
      : "pass"
  return { status, issues }
}

// ─── 7. Write the file the dashboard imports ──────────────────────────────
function writeDataset(
  slug: string,
  data: Record<Kind, Statement>,
  sources: { year: number; url: string }[],
  validation: ValidationResult
): string {
  mkdirSync(APP_DATA_DIR, { recursive: true })
  const file = join(APP_DATA_DIR, `${slug}.ts`)
  writeFileSync(
    file,
    `// Generated by crawler/src/extract.ts — do not edit by hand.\n` +
      `import type { StatementData } from "@/lib/types"\n\n` +
      `// The report PDFs these numbers were extracted from.\n` +
      `export const sources = ${JSON.stringify(sources, null, 2)}\n\n` +
      `// Cross-statement validation result (accounting identities) at extraction time.\n` +
      `export const validation = ${JSON.stringify(validation, null, 2)} as const\n\n` +
      `export const incomeStatement: StatementData = ${JSON.stringify(data.income, null, 2)}\n\n` +
      `export const balanceSheet: StatementData = ${JSON.stringify(data.balance, null, 2)}\n\n` +
      `export const cashFlowStatement: StatementData = ${JSON.stringify(data.cashflow, null, 2)}\n\n` +
      `export default { incomeStatement, balanceSheet, cashFlowStatement, sources, validation }\n`
  )
  return file
}

// A statement can spread across consecutive pages (e.g. a balance sheet split into
// "Assets" | "Equity and liabilities"). Include an adjacent page when it's a continuation:
// not already claimed by another statement, and carrying no OTHER statement's heading.
// `claimed` holds every page already assigned (incl. all statement picks), so no page
// ends up counted in two statements.
function statementSpan(
  kind: Kind,
  picked: number,
  cleaned: string[],
  claimed: Set<number>
): number[] {
  const otherHeads = KINDS.filter((k) => k !== kind)
    .flatMap((k) => HEADINGS[k])
    .concat("comprehensive income", "changes in equity")
  const span = [picked]
  for (const nb of [picked - 1, picked + 1]) {
    if (nb < 0 || nb >= cleaned.length || claimed.has(nb)) continue
    if (otherHeads.some((h) => cleaned[nb].toLowerCase().includes(h))) continue
    span.push(nb)
  }
  return [...new Set(span)].sort((a, b) => a - b)
}

// The real consolidated balance sheet is the ONE page that carries both sides of the
// accounting identity — "total assets" AND "total equity and liabilities" (it balances).
// A "Selected Financial Data" / 5-year-summary table lists total assets alone, so it lacks
// this signature — which is exactly how the locator gets fooled on long filings (e.g. SAP's
// 20-F). Return the signature page, preferring the one nearest the income statement (the
// consolidated statements sit together, so this avoids a parent-company balance sheet).
function balanceSheetPage(pages: string[], near?: number): number | null {
  const hits: number[] = []
  pages.forEach((p, i) => {
    const low = p.toLowerCase()
    const hasAssets = low.includes("total assets")
    const hasEqLiab =
      low.includes("total equity and liabilities") ||
      low.includes("total liabilities and equity") ||
      low.includes("total liabilities and shareholders") ||
      (low.includes("total equity") && low.includes("total liabilities"))
    if (hasAssets && hasEqLiab) hits.push(i)
  })
  if (hits.length === 0) return null
  if (near == null) return hits[0]
  return hits.reduce((best, i) =>
    Math.abs(i - near) < Math.abs(best - near) ? i : best
  )
}

// The consolidated statement of cash flows is the one page carrying all three activity
// sections — operating, investing AND financing — plus the "cash and cash equivalents at the
// end" line. Notes, MD&A liquidity/net-debt tables and employee disclosures lack this full
// signature, so this stops the locator grabbing them (SAP's 20-F scatters such tables
// throughout, which is why its cash flow was pulling employee-headcount rows).
function cashFlowPage(pages: string[], near?: number): number | null {
  const hits: number[] = []
  pages.forEach((p, i) => {
    const low = p.toLowerCase()
    const ok =
      low.includes("operating activities") &&
      low.includes("investing activities") &&
      low.includes("financing activities") &&
      (low.includes("cash and cash equivalents at the end") ||
        low.includes("cash and cash equivalents at end") ||
        low.includes("at the end of the period") ||
        low.includes("at the end of the year") ||
        low.includes("at end of"))
    if (ok) hits.push(i)
  })
  if (hits.length === 0) return null
  if (near == null) return hits[0]
  return hits.reduce((best, i) =>
    Math.abs(i - near) < Math.abs(best - near) ? i : best
  )
}

// ─── Glue: run one report through the pipeline ────────────────────────────
// The extracted statements for one report year.
interface Report {
  year: number
  income: Statement
  balance: Statement
  cashflow: Statement
}

async function readReport(
  client: OpenAI,
  year: number,
  refresh: boolean
): Promise<Report> {
  // LLM-response cache: once a year's statements are extracted, re-runs read them
  // straight from disk with no classify/extract calls. --refresh re-extracts.
  const cacheFile = join(CACHE_DIR, `${SLUG}-${year}.extracted.json`)
  if (!refresh && existsSync(cacheFile)) {
    console.log(`  ${year}: cached (no LLM)`)
    return JSON.parse(readFileSync(cacheFile, "utf-8")) as Report
  }

  console.log(`  reading ${year}…`)
  let pages: string[]
  try {
    pages = await loadPages(year, refresh)
  } catch (err) {
    // e.g. discovery found no official PDF for this year — skip it, keep the other years.
    console.warn(`    ${year}: ${(err as Error).message} — skipped`)
    const empty: Statement = { periods: [], rows: [] }
    return { year, income: empty, balance: empty, cashflow: empty }
  }

  // Scope gate (no LLM): current scope is ENGLISH-language reports (IFRS or US GAAP).
  // Non-English text breaks the English keyword anchors, so stop before spending any
  // LLM tokens on locating/extracting.
  if (!looksEnglish(pages)) {
    console.warn(
      `    ${year}: report is not in English — skipped (scope: English-language reports)`
    )
    const empty: Statement = { periods: [], rows: [] }
    return { year, income: empty, balance: empty, cashflow: empty }
  }

  const cleaned = stripBoilerplate(pages)

  // Human override (escape hatch): --pages income:198,balance:199,cashflow:200 pins the
  // pages directly, skipping the locator. Default path is fully automatic.
  let picks: Record<Kind, number | null> = {
    income: PAGES_OVERRIDE.income ?? null,
    balance: PAGES_OVERRIDE.balance ?? null,
    cashflow: PAGES_OVERRIDE.cashflow ?? null,
  }

  // Locate each statement's page in ONE LLM call from the report's heading map (only for
  // kinds not pinned by --pages). A kind the locator misses falls back to the top keyword
  // page for that kind.
  if (KINDS.some((k) => picks[k] === null)) {
    const auto = await locateStatements(client, cleaned)
    const { byKind } = candidatePages(pages)
    for (const kind of KINDS)
      if (picks[kind] === null)
        picks[kind] = auto[kind] ?? byKind[kind][0] ?? null
    console.log(
      `    located: income ${picks.income}, balance ${picks.balance}, cashflow ${picks.cashflow}`
    )
  }

  // Deterministic balance-sheet correction (unless --pages pinned it): snap `balance` to the
  // page carrying the full identity signature — "total assets" AND "total equity and
  // liabilities" — nearest the income statement. Fixes the locator grabbing a summary table
  // (e.g. SAP's 20-F); a no-op when it already picked the right page, and skipped when the
  // balance sheet is split across two pages (no single page has both, so `sig` is null).
  if (PAGES_OVERRIDE.balance == null) {
    const sig = balanceSheetPage(pages, picks.income ?? undefined)
    if (sig != null && sig !== picks.balance) {
      console.log(`    balance → page ${sig} (balance-sheet signature)`)
      picks.balance = sig
    }
  }
  // Same idea for the cash flow statement: snap to the page with all three activity sections
  // plus the ending-cash line, so notes / liquidity tables don't get pulled in.
  if (PAGES_OVERRIDE.cashflow == null) {
    const sig = cashFlowPage(pages, picks.income ?? undefined)
    if (sig != null && sig !== picks.cashflow) {
      console.log(`    cashflow → page ${sig} (cash-flow signature)`)
      picks.cashflow = sig
    }
  }

  // Assign each page to at most one statement (earlier statements claim their continuation
  // first), so a shared continuation page never lands in two statements.
  const claimed = new Set<number>(
    KINDS.map((k) => picks[k]).filter((v): v is number => v != null)
  )
  const spans: Partial<Record<Kind, number[]>> = {}
  for (const kind of [...KINDS].sort(
    (a, b) => (picks[a] ?? 1e9) - (picks[b] ?? 1e9)
  )) {
    const idx = picks[kind]
    if (idx == null) continue
    const span = statementSpan(kind, idx, cleaned, claimed)
    span.forEach((p) => claimed.add(p))
    spans[kind] = span
  }

  const statement = async (kind: Kind): Promise<Statement> => {
    const span = spans[kind]
    if (!span) {
      console.warn(`    ${kind}: no page found in ${year} — skipped`)
      return { periods: [], rows: [] }
    }
    console.log(`    ${kind}: page ${span.join("+")}`)
    return extractStatement(client, span.map((p) => pages[p]).join("\n"), kind)
  }

  const report: Report = {
    year,
    income: await statement("income"),
    balance: await statement("balance"),
    cashflow: await statement("cashflow"),
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(report))
  return report
}

async function main() {
  loadEnv()
  // Provider (cloudflare | groq | openai) + its default model, from LLM_PROVIDER in .env.
  // OPENAI_MODEL overrides the model for any provider.
  MODEL = resolveProvider().model

  const flags = new Set(process.argv.slice(2))
  const client = makeClient()

  if (flags.has("--check")) {
    await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    })
    return console.log(`✓ ${MODEL} works.`)
  }

  // Known company from the registry, or an ad-hoc one (name → discovery handles the URL).
  const arg = argValue("--company") ?? "sap"
  if (COMPANIES[arg]) {
    SLUG = arg
    COMPANY = COMPANIES[arg]
  } else {
    SLUG = arg
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    COMPANY = { name: arg, years: [], pdf: {} }
  }
  // --slug pins the cache/output slug (e.g. keep "SAP SE" → sap so it matches the
  // frontend's lib/data/sap.ts and reuses cache from an earlier run).
  const slugOverride = argValue("--slug")
  if (slugOverride) SLUG = slugOverride

  // --pages pins statement page indices, bypassing the locator (escape hatch).
  PAGES_OVERRIDE = parsePages(argValue("--pages"))

  const years =
    parseYears(argValue("--years")) ??
    (COMPANY.years.length
      ? COMPANY.years
      : fail(`Pass --years for '${arg}', e.g. --years 2024-2024`))
  const refresh = flags.has("--refresh")
  console.log(`=== ${COMPANY.name} — years ${years.at(0)}–${years.at(-1)} ===`)

  // Each year is independent: if one fails (discovery, download, an LLM error…), skip it
  // and keep going, so a 10-year run never dies on a single bad year.
  const empty: Statement = { periods: [], rows: [] }
  const reports = []
  for (const year of [...years].sort((a, b) => b - a)) {
    try {
      reports.push(await readReport(client, year, refresh))
    } catch (err) {
      console.warn(`  ${year}: failed (${(err as Error).message}) — skipped`)
      reports.push({ year, income: empty, balance: empty, cashflow: empty })
    }
  }

  // Provenance: best-effort URL (registry/cache; populated by discovery if it ran).
  const sources = [...years]
    .sort((a, b) => b - a)
    .map((year) => ({ year, url: registeredUrl(year) ?? "" }))

  const data: Record<Kind, Statement> = {
    income: compile(
      reports.map((r) => ({ year: r.year, statement: r.income }))
    ),
    balance: compile(
      reports.map((r) => ({ year: r.year, statement: r.balance }))
    ),
    cashflow: compile(
      reports.map((r) => ({ year: r.year, statement: r.cashflow }))
    ),
  }

  // reconcile() is a naive intra-statement subtotal heuristic (sign conventions and
  // multi-level subtotals make it noisy) — informational only. The cross-statement
  // validation below is the authoritative check. Use --verbose to see the notes.
  for (const kind of KINDS) {
    const notes = reconcile(data[kind])
    console.log(
      `  ${kind}: ${data[kind].periods.length} periods, ${data[kind].rows.length} rows` +
        (notes.length
          ? ` (${notes.length} subtotal notes — informational)`
          : "")
    )
    if (flags.has("--verbose"))
      notes.slice(0, 3).forEach((p) => console.log(`    · ${p}`))
  }

  // Cross-statement validation on the FINAL merged data (deterministic accounting
  // identities). Reported by severity; --strict blocks the write only on a hard FAIL.
  const result = validateStatements(data)
  console.log(
    `  validation: ${result.status.toUpperCase()}${result.issues.length ? ` (${result.issues.length} issue(s))` : ""}`
  )
  result.issues.forEach((i) =>
    console.log(
      `    ${i.severity === "fail" ? "✗" : "⚠"} ${i.check} @ ${i.period}: ${Math.round(i.actual)} vs ${Math.round(i.expected)} (Δ ${Math.round(i.diff)})`
    )
  )
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(
    join(CACHE_DIR, `${SLUG}.validation.json`),
    JSON.stringify({ slug: SLUG, ...result }, null, 2)
  )

  if (flags.has("--dry-run")) return console.log("\n(dry run — not written)")
  if (flags.has("--strict") && result.status === "fail")
    fail("Validation FAILED (--strict) — dataset not written.")
  console.log(`\nWrote ${writeDataset(SLUG, data, sources, result)}`)
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function parseYears(v?: string): number[] | undefined {
  if (!v) return undefined
  const m = v.match(/^(\d{4})-(\d{4})$/)
  if (!m) fail("--years must look like 2015-2025")
  return range(Number(m![1]), Number(m![2]))
}

// --pages income:198,balance:199,cashflow:200 → { income:198, balance:199, cashflow:200 }
function parsePages(v?: string): Partial<Record<Kind, number>> {
  const out: Partial<Record<Kind, number>> = {}
  if (!v) return out
  for (const part of v.split(",")) {
    const [k, n] = part.split(":").map((s) => s.trim())
    if ((KINDS as string[]).includes(k) && /^\d+$/.test(n ?? ""))
      out[k as Kind] = Number(n)
  }
  return out
}

function loadEnv(path = join(HERE, "..", ".env")): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#") || !t.includes("=")) continue
    const i = t.indexOf("=")
    const key = t.slice(0, i).trim()
    if (!(key in process.env))
      process.env[key] = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
  }
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
