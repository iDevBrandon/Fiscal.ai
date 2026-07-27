/*
 * Turn a company's annual reports into the three financial statements the
 * dashboard shows (Income Statement, Balance Sheet, Cash Flow).
 *
 * Pipeline (top to bottom):
 *
 *   1. download the PDF (cached on disk)               downloadPdf / ensurePdf
 *   2. split it into per-page text (cached on disk)    loadPages
 *   3. keyword pre-filter to a few candidate pages     candidatePages   (no LLM)
 *   4. LLM classifies which page is which statement    classifyPages    (1 call)
 *   5. LLM transcribes the table on that page          extractStatement (3 calls)
 *   6. merge years, check totals, write the file       compile / reconcile / write
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
  fail(`Discovery could not find a PDF for ${SLUG} ${year}.`)
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
const SECTION_CONFIDENCE_MIN = 0.6 // below this, the section locator retries + widens

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

// ─── 3c. Section locator (LLM): which page range holds the primary statements? ──
// Step 1 of a two-step locate. The three statements sit together in the "Consolidated
// Financial Statements" section, right before the notes. We hand the LLM a MAP of the
// report's statement/section headings (page index → heading, from the boilerplate-stripped
// text) and let it pick that section's page range. Feeding a whole-document map — rather
// than a hand-tuned keyword candidate list — is what lets this generalize across very
// different layouts (a management report full of the same figures no longer fools it).
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
      map.push({ i, head: flat.slice(0, 80) })
    }
  }
  return map
}

interface Section {
  window: [number, number]
  confidence: number
}
async function locateSection(
  client: OpenAI,
  cleaned: string[]
): Promise<Section | null> {
  const map = headingMap(cleaned)
  if (map.length === 0) return null

  const res = await chat(client, {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Below is a MAP of an annual report — a page index and the statement/section heading\n" +
          "found on each listed page. Return the page range of the PRIMARY CONSOLIDATED FINANCIAL\n" +
          "STATEMENTS: the actual Income Statement, Balance Sheet / Statement of Financial Position\n" +
          "and Cash Flow Statement tables. They sit together, just BEFORE 'Notes to the consolidated\n" +
          "financial statements'. IGNORE the management report, governance, sustainability, the notes,\n" +
          "and the auditor's report. `start` = first statement page, `end` = last statement page\n" +
          "(the one right before the notes begin). Also give `confidence` (0-1): how sure you are\n" +
          "this range is the primary statements and not the notes or management report.\n" +
          'Return ONLY JSON: { "start": <index>, "end": <index>, "confidence": <0..1> }',
      },
      { role: "user", content: map.map((m) => `p${m.i}: ${m.head}`).join("\n") },
    ],
  })
  const parsed = parseJson(res)
  const start = parsed.start
  const end = parsed.end
  if (typeof start !== "number" || typeof end !== "number" || end < start)
    return null
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5
  return {
    window: [Math.max(0, start), Math.min(end + 1, cleaned.length - 1)],
    confidence,
  }
}

// ─── 4. LLM classifier: which candidate page is which statement ───────────
// One call. Reads short snippets of the candidate pages and picks the CONSOLIDATED
// group statement for each kind (parent-company standalone pages are "none").
async function classifyPages(
  client: OpenAI,
  pages: string[],
  candidateIdx: number[]
): Promise<Record<Kind, number | null>> {
  const snippets = candidateIdx
    .map((i) => `Page ${i}: ${pages[i].replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n\n")

  const instructions =
    "You are given candidate pages from an annual report. For each of the three PRIMARY\n" +
    "CONSOLIDATED statements, return the page index whose MAIN TABLE is that statement:\n" +
    "  income   = Consolidated Income Statement / Statement of Operations / Profit and Loss\n" +
    "  balance  = Consolidated Balance Sheet / Statement of Financial Position\n" +
    "  cashflow = Consolidated Statement of Cash Flows\n" +
    "Pick by the statement's ROLE, not an exact title, and choose the CONSOLIDATED GROUP figures.\n" +
    "Return null (do NOT pick) for these look-alikes:\n" +
    "  - Parent-company / standalone / separate financial statements (local GAAP, e.g. HGB)\n" +
    "  - Statement of Comprehensive Income\n" +
    "  - Statement of Changes in Equity\n" +
    "  - Segment reporting, and any Notes / tax / PP&E / lease / financial-instrument tables\n" +
    'Return ONLY JSON: { "income": <index or null>, "balance": <index or null>, "cashflow": <index or null> }'

  const res = await chat(client, {
    model: MODEL,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: `Candidate pages:\n\n${snippets}` },
    ],
  })

  const parsed = parseJson(res)
  const pick = (v: unknown) =>
    typeof v === "number" && candidateIdx.includes(v) ? v : null
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
  return { periods: parsed.periods ?? [], rows: parsed.rows ?? [] }
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
function compile(reports: { year: number; statement: Statement }[]): Statement {
  const newestFirst = [...reports].sort((a, b) => b.year - a.year)

  const labelByYear = new Map<number, string>()
  for (const { statement } of newestFirst) {
    for (const period of statement.periods) {
      const y = yearOf(period)
      if (y !== null && !labelByYear.has(y)) labelByYear.set(y, period)
    }
  }
  const years = [...labelByYear.keys()].sort((a, b) => b - a)
  const periods = years.map((y) => labelByYear.get(y)!)

  const labels: Row[] = []
  const seen = new Set<string>()
  for (const { statement } of newestFirst) {
    for (const row of statement.rows) {
      if (seen.has(row.label)) continue
      seen.add(row.label)
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
    const row: Row = { label: template.label, kind: template.kind, values }
    if (template.unit) row.unit = template.unit
    if (template.decimals !== undefined) row.decimals = template.decimals
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
  const row = statement.rows.find((r) => r.label === label)
  if (!row) return null
  const col = statement.periods.findIndex((p) => yearOf(p) === year)
  return col === -1 ? null : (row.values[col] ?? null)
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
        const sum = lines.reduce((acc, l) => acc + (l.values[i] ?? 0), 0)
        const got = row.values[i]
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

// ─── 7. Write the file the dashboard imports ──────────────────────────────
function writeDataset(
  slug: string,
  data: Record<Kind, Statement>,
  sources: { year: number; url: string }[]
): string {
  mkdirSync(APP_DATA_DIR, { recursive: true })
  const file = join(APP_DATA_DIR, `${slug}.ts`)
  writeFileSync(
    file,
    `// Generated by crawler/src/extract.ts — do not edit by hand.\n` +
      `import type { StatementData } from "@/lib/types"\n\n` +
      `// The report PDFs these numbers were extracted from.\n` +
      `export const sources = ${JSON.stringify(sources, null, 2)}\n\n` +
      `export const incomeStatement: StatementData = ${JSON.stringify(data.income, null, 2)}\n\n` +
      `export const balanceSheet: StatementData = ${JSON.stringify(data.balance, null, 2)}\n\n` +
      `export const cashFlowStatement: StatementData = ${JSON.stringify(data.cashflow, null, 2)}\n\n` +
      `export default { incomeStatement, balanceSheet, cashFlowStatement, sources }\n`
  )
  return file
}

// A statement can spread across consecutive pages (e.g. a balance sheet split into
// "Assets" | "Equity and liabilities"). Include an adjacent page when it's a continuation:
// not the page picked for another statement, and carrying no OTHER statement's heading.
function statementSpan(
  kind: Kind,
  picked: number,
  picks: Record<Kind, number | null>,
  cleaned: string[]
): number[] {
  const otherHeads = KINDS.filter((k) => k !== kind)
    .flatMap((k) => HEADINGS[k])
    .concat("comprehensive income", "changes in equity")
  const takenByOther = new Set(
    KINDS.filter((k) => k !== kind)
      .map((k) => picks[k])
      .filter((v): v is number => v != null)
  )
  const span = [picked]
  for (const nb of [picked - 1, picked + 1]) {
    if (nb < 0 || nb >= cleaned.length || takenByOther.has(nb)) continue
    const low = cleaned[nb].toLowerCase()
    if (otherHeads.some((h) => low.includes(h))) continue
    span.push(nb)
  }
  return [...new Set(span)].sort((a, b) => a - b)
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
  const pages = await loadPages(year, refresh)

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

  // Two-step locate (only for kinds not pinned by --pages):
  //   1. Section Locator (LLM) reads a heading map → the statements' page range.
  //   2. Statement Locator (LLM) assigns income/balance/cashflow within that range.
  // Falls back to whole-document keyword candidates if no section is found.
  if (KINDS.some((k) => picks[k] === null)) {
    const { byKind, union } = candidatePages(pages)
    let auto: Record<Kind, number | null> = {
      income: null,
      balance: null,
      cashflow: null,
    }
    // Section Locator returns a confidence; on a low score, retry once (LLM sampling
    // varies) and take the better answer, then widen the window so the Statement Locator
    // isn't boxed into a possibly-wrong range.
    let section = await locateSection(client, cleaned)
    if (section && section.confidence < SECTION_CONFIDENCE_MIN) {
      console.warn(
        `    section confidence ${section.confidence.toFixed(2)} low — retrying`
      )
      const retry = await locateSection(client, cleaned)
      if (retry && retry.confidence > section.confidence) section = retry
    }
    if (section) {
      let [lo, hi] = section.window
      if (section.confidence < SECTION_CONFIDENCE_MIN) {
        lo = Math.max(0, lo - 5)
        hi = Math.min(cleaned.length - 1, hi + 5)
      }
      console.log(
        `    statements section: pages ${lo}–${hi} (confidence ${section.confidence.toFixed(2)})`
      )
      const idx = range(lo, hi).filter((i) => i >= 0 && i < cleaned.length)
      auto = await classifyPages(client, cleaned, idx)
    } else if (union.length) {
      auto = await classifyPages(client, pages, union)
    }
    for (const kind of KINDS)
      if (picks[kind] === null)
        picks[kind] = auto[kind] ?? byKind[kind][0] ?? null
  }

  const statement = async (kind: Kind): Promise<Statement> => {
    const idx = picks[kind]
    if (idx == null) {
      console.warn(`    ${kind}: no page found in ${year} — skipped`)
      return { periods: [], rows: [] }
    }
    const span = statementSpan(kind, idx, picks, cleaned)
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
  // OPENAI_MODEL overrides the default — handy for probing which model is live:
  //   OPENAI_MODEL=@cf/... pnpm run extract -- --check
  MODEL =
    process.env.OPENAI_MODEL ||
    (process.env.CLOUDFLARE_ACCOUNT_ID
      ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      : "gpt-4o")

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

  const reports = []
  for (const year of [...years].sort((a, b) => b - a))
    reports.push(await readReport(client, year, refresh))

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

  for (const kind of KINDS) {
    const problems = reconcile(data[kind])
    console.log(
      `  ${kind}: ${data[kind].periods.length} periods, ${data[kind].rows.length} rows, ${problems.length} check issue(s)`
    )
    problems.slice(0, 3).forEach((p) => console.log(`    ⚠ ${p}`))
  }

  if (flags.has("--dry-run")) return console.log("\n(dry run — not written)")
  console.log(`\nWrote ${writeDataset(SLUG, data, sources)}`)
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────
function makeClient(): OpenAI {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (account && token) {
    return new OpenAI({
      apiKey: token,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
    })
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    })
  }
  fail(
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or OPENAI_API_KEY) in your environment"
  )
}

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
