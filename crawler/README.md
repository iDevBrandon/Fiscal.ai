# Financial statement extractor

Turns a company's annual-report PDFs into the three statements the dashboard shows
— Income Statement, Balance Sheet, Cash Flow — written into the app's schema.

```bash
find URL ─▶ download (cache) ─▶ per-page text (cache) ─▶ keyword pre-filter ─▶ LLM classify page
                                                                                      │
                        lib/data/<slug>.ts ◀─ check ◀─ merge years ◀─ (cache) ◀─ LLM extract table
```

It's one file, `src/extract.ts`, meant to be read top to bottom. The report is
split into per-page text; a cheap keyword pass narrows hundreds of pages to a few
candidates; the LLM then (1) classifies which candidate page is the _consolidated_
income / balance / cash-flow statement and (2) transcribes that page's table into
rows. Merging years, flagging restatements and checking totals is plain code.

## Setup

```bash
cd crawler
pnpm install
```

Provide LLM credentials, either as shell exports or a `crawler/.env` file (gitignored):

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id>
CLOUDFLARE_API_TOKEN=<a token with the Workers AI permission>
```

The script builds the Cloudflare Workers AI endpoint from those two variables. (To
use OpenAI instead, set `OPENAI_API_KEY`.) `.env` is loaded automatically if present.

## Run

```bash
pnpm run extract -- --check                                    # just test the key
pnpm run extract -- --company "Rheinmetall AG" --years 2024-2025 --slug rheinmetall --refresh
pnpm run extract -- --company "Airbus SE" --years 2024-2025 --slug airbus --refresh
pnpm run extract -- --company "Novo Nordisk A/S" --years 2024-2025 --slug novo-nordisk --refresh
pnpm run extract -- --refresh                                  # ignore caches, redo everything
pnpm run extract -- --dry-run                                  # extract + check totals, don't write
pnpm run extract -- --company "JCDecaux" --years 2025-2025 --pages income:21,balance:19,cashflow:24
```

`--company` is the full company name (used by discovery to find the PDF) and
`--years` is required — e.g. `2023-2025`. The slug (output filename) is derived from
the name: `"Rheinmetall AG"` → `rheinmetall-ag` → `lib/data/rheinmetall-ag.ts`.

## Locating the statements

Finding _which_ of hundreds of pages holds each consolidated statement is the hard part
(dozens of tables look alike; the management report and notes repeat the same figures).
It runs as two LLM steps, mirroring how you'd do it by hand:

1. **Section Locator** — the report is stripped of repeated boilerplate (nav/headers),
   then a map of its statement/section headings (page index → heading) is handed to the
   LLM, which returns the page range of the primary _Consolidated Financial Statements_
   section (the tables that sit just before "Notes to the consolidated…"). Passing a
   whole-document map — not a hand-tuned keyword list — is what makes this generalize.
2. **Statement Locator** — within that small range, the LLM assigns income / balance /
   cash-flow to specific page indices, which are sliced directly (`pages[i]`), so a
   report's printed page numbers never enter the picture.

For the rare report the locator gets wrong, `--pages income:21,balance:19,cashflow:24`
pins the pages by hand (an escape hatch — the default path is fully automatic).

## How a company's PDF URL is resolved

There are **no hardcoded companies** — the `COMPANIES` registry in `extract.ts` is
empty by default. When a download is actually needed, the URL is resolved in order:

```bash
registry override → cache/discovered.json → discovery agent
```

- **registry** (`COMPANIES`, optional): hardcode a known/stable URL to skip discovery.
- **cache** (`cache/discovered.json`): URLs the agent already found, or that you
  pre-seed by hand as `{ "slug:year": "https://…/report.pdf" }`.
- **discovery agent** (`src/discover.ts`): on a miss, an LLM uses tools (web search,
  fetch page, list PDF links) to locate the annual-report PDF and saves the URL to
  `cache/discovered.json` — so you **discover once, then it's cached**.

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
