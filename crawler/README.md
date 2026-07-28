# Financial statement extractor

Turns a company's annual-report PDFs into the three statements the dashboard shows
— Income Statement, Balance Sheet, Cash Flow — written into the app's schema.

```bash
find URL ─▶ download (cache) ─▶ per-page text (cache) ─▶ keyword pre-filter ─▶ LLM classify page
                                                                                      │
                        lib/data/<slug>.ts ◀─ check ◀─ merge years ◀─ (cache) ◀─ LLM extract table
```

The report is split into per-page text; the balance-sheet and cash-flow pages are found
**deterministically** by the accounting signature each must satisfy (see _Locating the
statements_), the income page by the LLM; the LLM then transcribes each located table into rows.
Merging years, deduplicating labels, flagging restatements and checking totals is plain code.
Collection of the PDFs themselves is a separate step — see `src/catalog.ts` below.

## Setup

```bash
cd crawler
pnpm install
```

Provide credentials as shell exports or a `crawler/.env` file (gitignored):

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id>
CLOUDFLARE_API_TOKEN=<token with Workers AI + Browser Rendering permissions>
OPENAI_API_KEY=<optional, if LLM_PROVIDER=openai>
LLM_PROVIDER=openai            # openai | cloudflare | groq
```

The Cloudflare token needs **Workers AI** (for the extraction LLM if `LLM_PROVIDER=cloudflare`)
and **Browser Rendering** (for `catalog.ts`). To use OpenAI for extraction instead, set
`OPENAI_API_KEY` and `LLM_PROVIDER=openai`. `.env` is loaded automatically if present.

## Run

```bash
pnpm run extract -- --check                                    # just test the key
pnpm run extract -- --company "Airbus SE" --years 2024-2025 --slug airbus --refresh
pnpm run extract -- --company "Novo Nordisk" --years 2016-2025 --slug novonordisk --refresh
pnpm run extract -- --refresh                                  # ignore caches, redo everything
pnpm run extract -- --dry-run                                  # extract + check totals, don't write
```

`--company` is the full company name (used by discovery to find the PDF) and
`--years` is required — e.g. `2023-2025`. The slug (output filename) is derived from
the name: `"Rheinmetall AG"` → `rheinmetall-ag` → `lib/data/rheinmetall-ag.ts`.

## Locating the statements

Finding _which_ of hundreds of pages holds each consolidated statement is the hard part
(dozens of tables look alike; the notes and "Selected Financial Data" summaries repeat the
same figures). Two of the three are located **deterministically, without the LLM**, using the
accounting identity each statement must satisfy:

- **Balance sheet** = the page carrying both `total assets` **and** `total equity and
liabilities` (a balance sheet balances; a summary table lists total assets alone). Nearest the
  income statement, to prefer the consolidated one over a parent-company sheet.
- **Cash flow statement** = the page with all three sections — operating, investing **and**
  financing activities — plus the ending-cash line. Notes and MD&A liquidity tables lack the full
  signature, so they're skipped.
- **Income statement** = still LLM-located from the report's heading map (its signature — revenue
  - EPS — also appears in early summary tables, so a keyword heuristic is riskier here).

These signatures were verified across all 40 company-years and generalise (they encode a
universal property of the statements, not per-company tuning); when a signature isn't found the
code falls back to the LLM locator, so it never regresses. `--pages income:21,balance:19,cashflow:24`
pins pages by hand for the rare miss.

## Cataloging filings (`src/catalog.ts`)

The extractor above only needs one report per year. `catalog.ts` is the separate "scrape/classify
the whole IR site" step (the assignment's secondary output). IR archives are JavaScript-rendered,
so a static fetch sees nothing — this drives real headless Chrome via **Cloudflare Browser Run**
(`/links` quick action), which executes the page's JS and returns every rendered link. Each PDF is
classified by type (Annual Report, Half-Year, Earnings Presentation, Quarterly Statement,
ESG/Sustainability, Registration Document, …) and written to `lib/data/filings.ts` (the app's
**Filings** tab). It also fills any missing Annual-Report URL into `discovered.json`, so discovery
of the report to parse is automatic rather than hand-seeded.

```bash
pnpm run catalog                    # all companies
pnpm run catalog -- --company sap   # one (safe — merges, never wipes the others)
```

Needs a Cloudflare API token with the **Browser Rendering** permission (in addition to Workers AI).
Free tier is rate-limited, so it throttles and backs off on 429; run one company at a time if needed.

## How a company's PDF URL is resolved

There are **no hardcoded companies** — the `COMPANIES` registry in `extract.ts` is
empty by default. When a download is actually needed, the URL is resolved in order:

```bash
registry override → cache/discovered.json → discovery agent
```

- **registry** (`COMPANIES`, optional): hardcode a known/stable URL to skip discovery.
- **cache** (`cache/discovered.json`): URLs `catalog.ts` scraped (the Browser Run pass fills
  Annual-Report URLs here automatically), the discovery agent found, or you pre-seeded by hand.
- **discovery agent** (`src/discover.ts`): on a miss, an LLM uses tools (web search,
  fetch page, list PDF links) to locate the annual-report PDF and saves the URL to
  `cache/discovered.json` — so you **discover once, then it's cached**.

In practice `catalog.ts` (headless-browser scrape) populates `discovered.json` first, and the LLM
discovery agent is the fallback only for years the scrape didn't surface.

Resolution is lazy: if a year's page text is already cached, discovery never runs.
Limitation: the discovery tools fetch static HTML; JS-rendered download pages (e.g.
ASML's per-year viewer) would need a headless-browser tool, or a pre-seeded URL.

The classifier and extractor are accounting-standard-agnostic: the keyword pre-filter
covers both IFRS (SAP, Novo, Rheinmetall) and US GAAP (ASML) titles and line items.

## Scope

Current scope is **English-language annual reports (IFRS or US GAAP)**. A cheap,
deterministic English-language check (stopword density — no LLM) runs right after a PDF
is parsed; a report that isn't in English is skipped before any LLM tokens are spent on
it. Accounting standard is _not_ filtered — the anchors handle IFRS and US GAAP alike, so
US-GAAP filers like ASML are in scope. Non-English editions (e.g. a German-only report)
are out of scope for now.

## Caching (important for CI / GitHub Actions)

Everything expensive is cached under `crawler/cache/` (gitignored). Re-running a
company you already pulled costs **zero LLM calls**. Three files per `<slug>-<year>`,
plus one shared URL cache:

| File                           | Holds                         | Skips on re-run                                       |
| ------------------------------ | ----------------------------- | ----------------------------------------------------- |
| `<slug>-<year>.pdf`            | downloaded report             | the download                                          |
| `<slug>-<year>.pages.json`     | per-page text                 | download + PDF parse + **URL resolution / discovery** |
| `<slug>-<year>.extracted.json` | the 3 statements (LLM output) | the classify + extract **LLM calls**                  |
| `discovered.json`              | `{ "slug:year": url }`        | discovery for that company/year                       |

So a second run with the same arguments does no network and no LLM work — it just
re-merges and re-writes `lib/data/<slug>.ts`. Use `--refresh` to bust all caches and
re-extract from scratch (needed after tuning prompts).

**For GitHub Actions:** persist `crawler/cache/` with `actions/cache` (keyed on the
company/years, or just restore-always) so scheduled runs don't re-spend LLM quota on
reports that haven't changed. Only new years — or a `--refresh` run — hit the LLM.
Store the LLM credentials as repo secrets (`CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`) and export them into the job env. Note the Cloudflare free
tier caps at 10,000 neurons/day, which resets daily — batch big backfills accordingly.

## Testing the extraction

Work from cheapest to most thorough:

```bash
pnpm run typecheck                                              # 1. compiles clean?
pnpm run extract -- --check                                     # 2. LLM key/model reachable?
pnpm run extract -- --company "Novo Nordisk" --years 2024-2025 --slug nvo --dry-run
                                                               # 3. full run, validate, DON'T write
```

A healthy `--dry-run` prints the located pages, the row counts, and the validation line:

```text
    statements section: pages 101–104 (confidence 0.90)
    income: page 101   balance: page 103   cashflow: page 102
  income: 4 periods, 30 rows, ...
  validation: all checks passed ✓
```

**Two independent checks run on every extraction — deterministic maths, not the LLM:**

- `reconcile()` — _within_ each statement, do the line items sum to their subtotals.
  Noisy on multi-level statements (informational only).
- `validateStatements()` — _across_ statements, accounting identities that hold for any
  filer. Each issue has a severity:
  - **fail** — the balance sheet balances (`Total assets = Total equity + Total liabilities`)
  - **fail** — net profit is the same figure on the income and the cash-flow statement
  - **warning** — cash-flow ending cash = the balance sheet's cash line (reclassifications
    and restricted cash make this drift legitimately, so it never blocks)

  Status is `pass` / `warning` / `fail`. Results print to the console and are written to
  `cache/<slug>.validation.json` (`{ slug, status, issues }`). Add `--strict` to block the
  write on a hard **fail** (warnings never block) — use it in CI so bad data never reaches
  `lib/data/`.

**Spot-check against the PDF.** The strongest confidence check is still comparing a few
headline figures to the source: open the report and confirm e.g. Revenue, Net profit and
Total assets for the latest year match `lib/data/<slug>.ts`. The `sources` array in that
file has the exact PDF URLs the numbers came from.

**Reference companies** that extract and validate cleanly (good regression cases):
SAP, Novo Nordisk, JCDecaux, Rheinmetall, Airbus.

**When the locator gets a report wrong**, pin the pages by hand and re-run:

```bash
pnpm run extract -- --company "JCDecaux" --years 2025-2025 --slug jcdecaux \
  --pages income:21,balance:19,cashflow:24 --refresh
```

## Output

`../lib/data/<slug>.ts`, exporting `incomeStatement`, `balanceSheet`,
`cashFlowStatement`, and `sources` (the report URLs the numbers came from) — the
`StatementData` shape from `lib/types.ts`, ready for the dashboard to import.
