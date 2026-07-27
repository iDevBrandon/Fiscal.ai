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
        "FINANCIAL STATEMENTS (income statement, balance sheet, cash-flow statement) for a year.\n" +
        "\n" +
        "OFFICIAL SOURCES ONLY — this is strict:\n" +
        "- The PDF you save MUST be hosted on the company's OWN official domain (e.g. a URL on\n" +
        "  novonordisk.com / rheinmetall.com / airbus.com), or a link you found on the company's\n" +
        "  official investor-relations page.\n" +
        "- NEVER save a URL from a third-party site, mirror, blog, file-sharing host, university,\n" +
        "  SEC/EDGAR, or cached copy — even if the filename looks correct.\n" +
        "- Use web_search to find the official page/PDF; fetch_page / list_pdf_links to inspect it.\n" +
        '- If no official PDF exists, reply {"tool":"save_pdf_url","args":{"url":"NOT_FOUND"}}.\n' +
        "\n" +
        "Tools (use ONE per turn): web_search(query), fetch_page(url), list_pdf_links(url), save_pdf_url(url).\n" +
        "When several PDFs exist, prefer by title: (1) 'Financial Statements' / 'Consolidated\n" +
        "Financial Statements', then (2) 'Annual Report' / 'Universal/Registration Document' /\n" +
        "'Form 20-F' / '10-K'. DO NOT pick 'Report of the Board of Directors', 'Annual Review',\n" +
        "'Sustainability'/'ESG', 'Remuneration', 'Governance', 'Presentation', or ESEF/XBRL packages.\n" +
        "Reply with ONLY a JSON object, e.g.\n" +
        '{"tool":"web_search","args":{"query":"Company official investor relations annual report"}}',
    },
    {
      role: "user",
      content: `Company: ${company}\nYear: ${year}\nFind the consolidated financial statements PDF on ${company}'s OFFICIAL site. Reply with your first action as JSON.`,
    },
  ]

  // PDFs discovered on the company's OWN domain — the only URLs we'll save. This is what
  // makes "official sources only" real: a mirror's URL never enters this set, so it can't
  // be saved even if the model tries (and a company CDN link found on the official page is
  // trusted, because the trust comes from the page it was listed on, not the PDF's host).
  const officialPdfs = new Set<string>()

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
      const url = action.args.url
      if (url === "NOT_FOUND") {
        console.error(`  no official PDF found for ${slug} ${year}`)
        return null
      }
      // Accept a PDF that is EITHER on the company's own domain (novonordisk.com/…),
      // OR was listed on the company's official page (covers company CDNs like the
      // JCDecaux cloudfront host). A mirror satisfies neither → rejected.
      if (!isOfficialHost(url, company) && !officialPdfs.has(url)) {
        console.error(`  ✗ rejected (not an official source): ${url.slice(0, 80)}`)
        messages.push({
          role: "user",
          content:
            `Rejected: "${url}" is not on ${company}'s official domain and was not listed on ` +
            `its official investor-relations page. Only save a PDF hosted on the company's own ` +
            `website (or linked from its official IR page). Search for the official one, or reply ` +
            `{"tool":"save_pdf_url","args":{"url":"NOT_FOUND"}}.`,
        })
        continue
      }
      saveUrl(slug, year, url)
      console.log(`\n✓ ${slug} ${year}: ${url}`)
      console.log(`  saved to ${DISCOVERED}`)
      return url
    }

    let result: unknown
    try {
      result = await dispatch(action.tool, action.args)
    } catch (err) {
      result = { error: (err as Error).message }
    }

    // Only record PDFs listed on the company's OWN domain as savable.
    if (
      (action.tool === "list_pdf_links" || action.tool === "fetch_page") &&
      isOfficialHost(String(action.args.url ?? ""), company)
    ) {
      const links = ((result as { pdfLinks?: unknown; links?: unknown }).pdfLinks ??
        (result as { links?: unknown }).links ??
        []) as { href?: string }[]
      for (const l of links)
        if (
          typeof l?.href === "string" &&
          l.href.toLowerCase().split("?")[0].endsWith(".pdf")
        )
          officialPdfs.add(l.href)
    }

    messages.push({
      role: "user",
      content: `Result of ${action.tool}:\n${JSON.stringify(result).slice(0, 6000)}\n\nReply with your next action as JSON.`,
    })
  }
  return null
}

// Does this URL's hostname belong to the company? Derives name tokens from the company
// name (dropping legal suffixes) and checks the host contains one — so ir.rheinmetall.com
// and mediaassets.airbus.com pass, but vanslingerlandt.com / hauptversammlung.de do not.
function officialTokens(company: string): string[] {
  const stop = new Set([
    "ag", "se", "sa", "nv", "as", "plc", "inc", "corp", "co", "ltd",
    "limited", "holding", "holdings", "group", "the", "company",
  ])
  const words = company
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w))
  return [words.join(""), ...words].filter((t) => t.length >= 3)
}
function isOfficialHost(url: string, company: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return false
  }
  return officialTokens(company).some((t) => host.includes(t))
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

// Discovery drives a JSON-action loop over plain chat (no function-calling needed), so it
// uses the provider's model by default. DISCOVERY_MODEL overrides just the discovery step.
function resolveModel(): string {
  return process.env.DISCOVERY_MODEL || resolveProvider().model
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

// LLM provider selection via LLM_PROVIDER (cloudflare | groq | openai). Each provider has
// its own API key + default model; OPENAI_MODEL overrides the model for whichever is active.
// Shared by extract.ts too, so switching providers is one .env variable in one place.
export interface ProviderConfig {
  apiKey: string
  baseURL?: string
  model: string
}
export function resolveProvider(): ProviderConfig {
  const provider = (process.env.LLM_PROVIDER || "cloudflare").toLowerCase()
  const model = (fallback: string) => process.env.OPENAI_MODEL || fallback
  if (provider === "groq") {
    const key = process.env.GROQ_API_KEY
    if (!key) fail("LLM_PROVIDER=groq but GROQ_API_KEY is not set")
    return {
      apiKey: key,
      baseURL: "https://api.groq.com/openai/v1",
      model: model("llama-3.3-70b-versatile"),
    }
  }
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY
    if (!key) fail("LLM_PROVIDER=openai but OPENAI_API_KEY is not set")
    return { apiKey: key, baseURL: process.env.OPENAI_BASE_URL, model: model("gpt-4o-mini") }
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token)
    fail("LLM_PROVIDER=cloudflare but CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set")
  return {
    apiKey: token,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
    model: model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  }
}
export function makeClient(): OpenAI {
  const p = resolveProvider()
  return new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL })
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
