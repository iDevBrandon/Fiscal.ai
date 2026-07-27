/*
 * Discovery Agent — finds a company's annual-report PDF URL.
 *
 * This automates the one per-company step. Given a company name and year, the LLM
 * uses tools (web search, fetch a page, list its PDF links) to locate the annual
 * report PDF, then saves the URL to cache/discovered.json. extract.ts reads that
 * cache when the registry has no URL — so you discover once, then it's cached.
 *
 *   Company + Year → search → visit IR page → find the PDF → save URL
 *
 * The extractor downstream is unchanged: a URL is a URL, whether hand-registered
 * or discovered here.
 *
 *   npm run discover -- --company "SAP SE" --year 2025
 *   npm run discover -- --company "Novo Nordisk" --year 2024 --slug nvo
 *
 * Limitation: the tools fetch static HTML. Pages that render their download links
 * with JavaScript (e.g. ASML's per-year viewer) would need a headless-browser tool.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import OpenAI from "openai"

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(HERE, "..", "cache")
const DISCOVERED = join(CACHE_DIR, "discovered.json") // { "slug:year": url }
let MODEL = "gpt-4o"
const USER_AGENT =
  "Mozilla/5.0 (compatible; fiscal-ai-discovery/1.0; +https://github.com/)"
const TIMEOUT_MS = 30_000

// ─── Tools the agent can call (plain functions, no LLM) ───────────────────
async function webSearch(
  query: string
): Promise<{ title: string; url: string }[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const html = await res.text()
  const out: { title: string; url: string }[] = []
  // DuckDuckGo wraps real URLs in a redirect with ?uddg=<encoded>
  for (const m of html.matchAll(
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g
  )) {
    let url = m[1]
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    out.push({ title: stripTags(m[2]), url })
    if (out.length >= 8) break
  }
  return out
}

async function fetchPage(url: string): Promise<{
  url: string
  title: string
  links: { text: string; href: string }[]
}> {
  const html = await getHtml(url)
  const title = /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1]?.trim() ?? ""
  const links: { text: string; href: string }[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gis)) {
    let href: string
    try {
      href = new URL(m[1], url).toString()
    } catch {
      continue
    }
    if (seen.has(href)) continue
    seen.add(href)
    const text = stripTags(m[2]).slice(0, 100)
    if (text || href.toLowerCase().includes(".pdf")) links.push({ text, href })
    if (links.length >= 200) break
  }
  return { url, title: stripTags(title), links }
}

async function listPdfLinks(
  url: string
): Promise<{ url: string; pdfLinks: { text: string; href: string }[] }> {
  const { links } = await fetchPage(url)
  return {
    url,
    pdfLinks: links.filter((l) =>
      l.href.toLowerCase().split("?")[0].endsWith(".pdf")
    ),
  }
}

function saveUrl(
  slug: string,
  year: number,
  url: string
): { saved: boolean; slug: string; year: number; url: string } {
  mkdirSync(CACHE_DIR, { recursive: true })
  const db = existsSync(DISCOVERED)
    ? JSON.parse(readFileSync(DISCOVERED, "utf-8"))
    : {}
  db[`${slug}:${year}`] = url
  writeFileSync(DISCOVERED, JSON.stringify(db, null, 2))
  return { saved: true, slug, year, url }
}

// ─── Agent loop ───────────────────────────────────────────────────────────
// We don't use the OpenAI `tools` param — Cloudflare's OpenAI-compatible endpoint
// doesn't reliably accept it. Instead the model replies with a plain-text JSON
// action ({ "tool", "args" }) that we parse and dispatch, so this runs on any chat
// model (the same one extraction uses). save_pdf_url is handled in the loop itself.
async function dispatch(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "web_search":
      return webSearch(args.query)
    case "fetch_page":
      return fetchPage(args.url)
    case "list_pdf_links":
      return listPdfLinks(args.url)
    default:
      return { error: `unknown tool ${name}` }
  }
}

export async function discoverPdfUrl(
  company: string,
  year: number,
  slug: string
): Promise<string | null> {
  // Resolve creds + model here too, so this works when extract.ts imports it
  // directly (discover's main() — which used to set these — never runs then).
  loadEnv()
  MODEL = resolveModel()
  console.error(`  discovery model: ${MODEL}`)
  const client = makeClient()
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You find the direct PDF URL of the report that CONTAINS A COMPANY'S CONSOLIDATED\n" +
        "FINANCIAL STATEMENTS (the income statement, balance sheet and cash-flow statement) for a\n" +
        "given year.\n" +
        "You have these tools; use ONE per turn:\n" +
        "- web_search(query): search the web; returns [{title, url}]\n" +
        "- fetch_page(url): a page's title and its on-page links\n" +
        "- list_pdf_links(url): only the PDF links on a page\n" +
        "- save_pdf_url(url): save the final PDF URL and finish\n" +
        "IMPORTANT — companies often publish SEVERAL PDFs for one year. Review ALL the links and\n" +
        "pick the one that holds the full financial statements. Order of preference by title:\n" +
        "  1. 'Financial Statements' / 'Consolidated Financial Statements'\n" +
        "  2. 'Annual Report' / 'Universal Registration Document' / 'Registration Document' / 'Form 20-F' / '10-K'\n" +
        "DO NOT pick: 'Report of the Board of Directors', 'Annual Review', 'Sustainability'/'ESG',\n" +
        "'Remuneration', 'Governance', 'Highlights', 'Presentation', 'Fact Sheet', or ESEF/XBRL\n" +
        "packages — these do NOT contain the full statements. Prefer the complete year-end report\n" +
        "over quarterly or partial files.\n" +
        "Reply with ONLY a JSON object, no prose, e.g.\n" +
        '{"tool":"web_search","args":{"query":"Company 2024 financial statements pdf"}}\n' +
        'When you have the direct .pdf URL, reply {"tool":"save_pdf_url","args":{"url":"https://…"}}.',
    },
    {
      role: "user",
      content: `Company: ${company}\nYear: ${year}\nFind the PDF that contains the consolidated financial statements. Reply with your first action as JSON.`,
    },
  ]

  for (let step = 0; step < 12; step++) {
    const res = await chatWithBackoff(client, { model: MODEL, messages })
    const content = res.choices[0].message.content ?? ""
    messages.push({ role: "assistant", content })

    const action = parseAction(content)
    if (!action) {
      messages.push({
        role: "user",
        content:
          'Reply with ONLY a JSON action, e.g. {"tool":"web_search","args":{"query":"…"}}.',
      })
      continue
    }
    console.error(
      `→ ${action.tool}(${JSON.stringify(action.args).slice(0, 90)})`
    )

    if (action.tool === "save_pdf_url" && typeof action.args.url === "string") {
      saveUrl(slug, year, action.args.url)
      console.log(`\n✓ ${slug} ${year}: ${action.args.url}`)
      console.log(`  saved to ${DISCOVERED}`)
      return action.args.url
    }

    let result: unknown
    try {
      result = await dispatch(action.tool, action.args)
    } catch (err) {
      result = { error: (err as Error).message }
    }
    messages.push({
      role: "user",
      content: `Result of ${action.tool}:\n${JSON.stringify(result).slice(0, 6000)}\n\nReply with your next action as JSON.`,
    })
  }
  return null
}

// Pull the { "tool", "args" } JSON action out of the model's reply (it may wrap it
// in prose or a ```json fence).
function parseAction(content: string): { tool: string; args: any } | null {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end === -1) return null
  try {
    const obj = JSON.parse(content.slice(start, end + 1))
    if (obj && typeof obj.tool === "string")
      return { tool: obj.tool, args: obj.args ?? {} }
  } catch {
    /* not JSON — the caller re-prompts */
  }
  return null
}

// Discovery drives a JSON-action loop over plain chat (no function-calling needed),
// so it uses the same model as extraction (OPENAI_MODEL). DISCOVERY_MODEL overrides
// just the discovery step if you want a different one.
function resolveModel(): string {
  return (
    process.env.DISCOVERY_MODEL ||
    process.env.OPENAI_MODEL ||
    (process.env.CLOUDFLARE_ACCOUNT_ID
      ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      : "gpt-4o")
  )
}

// One chat call, retrying on rate limits (429) and transient server errors (5xx).
// A daily neuron cap still fails after the retries — backoff only helps bursts.
async function chatWithBackoff(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create(params)
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0
      const retryable = status === 429 || (status >= 500 && status < 600)
      if (!retryable || attempt >= 5) throw err
      const waitMs = Math.min(30_000, 1000 * 2 ** attempt)
      console.error(
        `    rate-limited (${status}) — retrying in ${waitMs / 1000}s…`
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

async function main() {
  loadEnv()
  MODEL = resolveModel()

  const company = argValue("--company")
  if (!company)
    fail(
      'Usage: npm run discover -- --company "SAP SE" --year 2025 [--slug sap]'
    )
  const year = Number(argValue("--year") ?? new Date().getFullYear() - 1)
  const slug =
    argValue("--slug") ??
    company
      .toLowerCase()
      .split(/\s+/)[0]
      .replace(/[^a-z0-9]/g, "")

  console.log(`Discovering ${company} ${year}…`)
  const url = await discoverPdfUrl(company, year, slug)
  if (!url)
    fail(
      "Could not find a PDF URL. Try a different --company phrasing, or the page may be JS-rendered."
    )
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────
async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

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

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

// Only run the CLI when executed directly (not when imported by extract.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
}
