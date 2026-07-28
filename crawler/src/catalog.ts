/**
 * catalog.ts — the "scrape/classify all filings" step (the assignment's secondary output).
 *
 * The discovery agent (discover.ts) finds ONE annual report per year to feed the parser.
 * This does the opposite: it enumerates EVERY PDF on a company's IR site and classifies it
 * by document type. IR archives are JavaScript-rendered (SAP, LVMH), so a static fetch sees
 * nothing — this drives real headless Chrome via Cloudflare Browser Run, which executes the
 * page's JS and returns the fully-rendered link list.
 *
 * Writes two things:
 *   - ../lib/data/filings.ts  → the full classified catalog (the "Document Catalog" UI)
 *   - cache/discovered.json   → the Annual-Report URLs it found, so the extractor resolves
 *                               them automatically (replaces hand-seeding).
 *
 * Run:
 *   npm run catalog                    # all companies
 *   npm run catalog -- --company sap   # one
 *
 * Requires Cloudflare Browser Run enabled and CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 * (token needs the "Browser Rendering" permission) in crawler/.env.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Mirrors the Filing type in ../../lib/types.ts (the frontend). Kept local so the crawler's
// tsconfig doesn't have to reach across into the app.
type FilingType =
  | "Annual Report"
  | "Financial Statements"
  | "Integrated Report"
  | "Registration Document"
  | "Half-Year Report"
  | "Quarterly Statement"
  | "Earnings Presentation"
  | "ESG / Sustainability"
  | "Press Release"
  | "Other"
interface Filing {
  year: number | null
  type: FilingType
  title: string
  url: string
  usedForExtraction?: boolean
}

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(HERE, "..", "cache")
const APP_DATA_DIR = join(HERE, "..", "..", "lib", "data")

// One IR site per company. `slug` matches the frontend (lib/companies.ts) so the UI can look
// the catalog up; `crawlerSlug` matches the extractor's cache/output slug; `hosts` is the
// official-domain allow-list (we only keep PDFs served from the company itself); `pages` are
// the archive/listing pages Browser Run renders to harvest links.
interface CompanyCfg {
  slug: string
  crawlerSlug: string
  name: string
  hosts: string[]
  pages: string[]
}

const COMPANIES: CompanyCfg[] = [
  {
    slug: "nvo",
    crawlerSlug: "novonordisk",
    name: "Novo Nordisk",
    hosts: ["novonordisk.com", "annualreport.novonordisk.com"],
    pages: [
      "https://www.novonordisk.com/investors/annual-report.html",
      "https://www.novonordisk.com/investors/financial-results.html",
    ],
  },
  {
    slug: "sap",
    crawlerSlug: "sap",
    name: "SAP",
    hosts: ["sap.com"],
    pages: [
      "https://www.sap.com/investors/en/financial-documents-and-events/reports-archive.html",
      "https://www.sap.com/investors/en/financial-documents-and-events.html",
    ],
  },
  {
    slug: "lvmh",
    crawlerSlug: "lvmh",
    name: "LVMH",
    hosts: ["lvmh.com", "lvmh-com.cdn.prismic.io"],
    pages: [
      "https://www.lvmh.com/en/publications",
      "https://www.lvmh.com/en/investors/investors-and-analysts",
    ],
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Cloudflare Browser Run: render a page with real Chrome, return every link ───────────
// The free tier is rate-limited, so 429 backs off and retries instead of failing the page.
async function browserLinks(url: string, attempt = 0): Promise<string[]> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in crawler/.env")

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/links`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    // domcontentloaded fires early and reliably (networkidle0 never settles on pages with
    // analytics/ads, which timed out SAP); waitForTimeout then gives the archive's JS time to
    // inject the document list before we read links. visibleLinksOnly:false includes off-screen.
    body: JSON.stringify({
      url,
      visibleLinksOnly: false,
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 60000 },
      waitForTimeout: 8000,
    }),
  })

  if (res.status === 429 && attempt < 5) {
    const wait = 20000 * (attempt + 1) // 20s, 40s, 60s, 80s, 100s
    console.warn(`    rate limited — waiting ${wait / 1000}s then retrying…`)
    await sleep(wait)
    return browserLinks(url, attempt + 1)
  }

  const data = (await res.json()) as {
    success?: boolean
    result?: unknown
    errors?: unknown
  }
  if (!res.ok || data.success === false)
    throw new Error(
      `Browser Run ${res.status} for ${url}: ${JSON.stringify(data.errors ?? data)}`
    )

  const result = Array.isArray(data.result) ? data.result : []
  return result
    .map((l) =>
      typeof l === "string"
        ? l
        : ((l as { url?: string; href?: string }).url ??
          (l as { href?: string }).href ??
          "")
    )
    .filter(Boolean)
}

// ─── Classification: label a PDF by its filename/URL ─────────────────────────────────────
// Ordered most-specific first; the first rule that matches wins.
const RULES: [FilingType, RegExp][] = [
  ["Registration Document", /universal[-_ ]?registration|registration[-_ ]?document|\burd\b|document[-_ ]?enregistrement|ra-rf/],
  ["Integrated Report", /integrated[-_ ]?report/],
  ["ESG / Sustainability", /sustainab|\besg\b|human[-_ ]?rights|responsibility|climate|environment|csrd|tcfd|non[-_ ]?financial/],
  ["Earnings Presentation", /presentation|investor[-_ ]?deck|slides/],
  ["Half-Year Report", /half[-_ ]?year|halfyear|interim|semestriel|first[-_ ]?half|firsthalf|\bh1\b|1h20|9m/],
  ["Quarterly Statement", /quarter|\bq[1-4]\b|q[1-4]20/],
  ["Financial Statements", /financial[-_ ]?statements?|financial[-_ ]?documents?|financialdocuments|documents?[-_ ]financiers?|document[-_ ]financier/],
  ["Annual Report", /annual[-_ ]?report|annualreport|annual_report|form[-_ ]?20[-_ ]?f|20f|nn-ar|\bar\d{2}\b/],
  ["Press Release", /press|release|news|announcement|earnings|results/],
]

function classify(url: string): FilingType {
  const s = decodeURIComponent(url).toLowerCase()
  for (const [type, re] of RULES) if (re.test(s)) return type
  return "Other"
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(url.split("?")[0].split("/").pop() ?? url)
  } catch {
    return url
  }
}

function yearOf(name: string): number | null {
  const m = name.match(/(?:19|20)\d{2}/)
  if (m) return Number(m[0])
  // "NN-AR17", "AR16" → 20xx
  const ar = name.toLowerCase().match(/ar[-_]?(\d{2})\b/)
  if (ar) return 2000 + Number(ar[1])
  return null
}

function isPdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url)
}

// ─── Harvest one company ─────────────────────────────────────────────────────────────────
async function catalogCompany(
  cfg: CompanyCfg
): Promise<{ filings: Filing[]; scraped: number }> {
  const seen = new Set<string>()
  const filings: Filing[] = []
  let scraped = 0 // how many pages actually rendered (0 ⇒ don't overwrite existing catalog)
  for (const [idx, page] of cfg.pages.entries()) {
    if (idx > 0) await sleep(8000) // throttle to stay under the free-tier rate limit
    let links: string[] = []
    try {
      links = await browserLinks(page)
      scraped++
      console.log(`  ${page}: ${links.length} links`)
    } catch (err) {
      console.warn(`  ${page}: ${(err as Error).message} — skipped`)
      continue
    }
    for (const link of links) {
      let abs: string
      try {
        abs = new URL(link, page).href
      } catch {
        continue
      }
      if (!isPdf(abs)) continue
      const host = new URL(abs).hostname
      if (!cfg.hosts.some((h) => host.includes(h))) continue // official domain only
      if (seen.has(abs)) continue
      seen.add(abs)
      const title = fileName(abs)
      filings.push({ year: yearOf(title), type: classify(abs), title, url: abs })
    }
  }
  // Always include the annual reports actually parsed (from discovered.json) — the current IR
  // pages often link only recent files, but the older parsed reports belong in the catalog too.
  const discFile = join(CACHE_DIR, "discovered.json")
  if (existsSync(discFile)) {
    const disc: Record<string, string> = JSON.parse(readFileSync(discFile, "utf-8"))
    for (const [key, url] of Object.entries(disc)) {
      if (!key.startsWith(`${cfg.crawlerSlug}:`) || seen.has(url)) continue
      seen.add(url)
      const title = fileName(url)
      filings.push({
        year: yearOf(title) ?? (Number(key.split(":")[1]) || null),
        type: classify(url),
        title,
        url,
        usedForExtraction: true,
      })
    }
  }
  filings.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.type.localeCompare(b.type))
  return { filings, scraped }
}

// ─── discovered.json: fill any missing Annual-Report URL from the catalog ────────────────
// Only fills gaps (never clobbers a URL that already extracts), so this augments the extractor
// without breaking known-good years. Prefers "Annual Report", then "Financial Statements".
function fillDiscovered(cfg: CompanyCfg, filings: Filing[]): number {
  const file = join(CACHE_DIR, "discovered.json")
  const disc: Record<string, string> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf-8"))
    : {}
  const pick = (year: number) =>
    filings.find((f) => f.year === year && f.type === "Annual Report") ??
    filings.find((f) => f.year === year && f.type === "Financial Statements")
  let added = 0
  const years = [...new Set(filings.map((f) => f.year).filter((y): y is number => !!y))]
  for (const year of years) {
    const key = `${cfg.crawlerSlug}:${year}`
    if (disc[key]) continue
    const f = pick(year)
    if (f) {
      disc[key] = f.url
      added++
    }
  }
  if (added) {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(disc, null, 2) + "\n")
  }
  return added
}

// ─── Mark which catalog entries were actually parsed (from discovered.json) ──────────────
function markUsed(cfg: CompanyCfg, filings: Filing[]): void {
  const file = join(CACHE_DIR, "discovered.json")
  if (!existsSync(file)) return
  const disc: Record<string, string> = JSON.parse(readFileSync(file, "utf-8"))
  const used = new Set(
    Object.entries(disc)
      .filter(([k]) => k.startsWith(`${cfg.crawlerSlug}:`))
      .map(([, url]) => url)
  )
  for (const f of filings) if (used.has(f.url)) f.usedForExtraction = true
}

function writeCatalog(catalog: Record<string, Filing[]>): string {
  mkdirSync(APP_DATA_DIR, { recursive: true })
  const file = join(APP_DATA_DIR, "filings.ts")
  writeFileSync(
    file,
    `// Generated by crawler/src/catalog.ts — do not edit by hand.\n` +
      `import type { Filing } from "@/lib/types"\n\n` +
      `export const filings: Record<string, Filing[]> = ${JSON.stringify(catalog, null, 2)}\n`
  )
  return file
}

// Read the existing filings.ts back into an object, so a partial run merges instead of wiping.
function loadExisting(file: string): Record<string, Filing[]> {
  if (!existsSync(file)) return {}
  const m = readFileSync(file, "utf-8").match(
    /export const filings[^=]*=\s*(\{[\s\S]*\})\n/
  )
  try {
    return m ? (JSON.parse(m[1]) as Record<string, Filing[]>) : {}
  } catch {
    return {}
  }
}

async function main() {
  loadEnv()
  const only = argValue("--company")
  const targets = only ? COMPANIES.filter((c) => c.slug === only) : COMPANIES
  if (!targets.length) return console.error(`Unknown --company '${only}'`)

  // Start from what's already there — a rate-limited/failed scrape must never destroy good data.
  const outFile = join(APP_DATA_DIR, "filings.ts")
  const catalog = loadExisting(outFile)

  for (const cfg of targets) {
    console.log(`\n=== ${cfg.name} (${cfg.slug}) ===`)
    const { filings, scraped } = await catalogCompany(cfg)
    if (scraped === 0) {
      console.warn(
        `  → every page rate-limited/failed — keeping existing catalog for ${cfg.slug}`
      )
      continue
    }
    const added = fillDiscovered(cfg, filings)
    markUsed(cfg, filings)
    catalog[cfg.slug] = filings
    const byType = filings.reduce<Record<string, number>>((m, f) => {
      m[f.type] = (m[f.type] ?? 0) + 1
      return m
    }, {})
    console.log(`  → ${filings.length} PDFs classified:`, byType)
    if (added) console.log(`  → filled ${added} Annual-Report URL(s) into discovered.json`)
  }

  console.log(`\nWrote ${writeCatalog(catalog)}`)
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
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

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
