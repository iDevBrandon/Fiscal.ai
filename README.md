# Fiscal.ai — European financial-statement extractor

Scrapes each company's investor-relations filings, classifies them by document type,
parses the annual reports into the three core financial statements, and compiles a clean
**10-year view** per statement — every figure exactly as the company reported it.

**Live demo:** <https://fiscal-ai-web.vercel.app/>

## How to run

set LLM_PROVIDER=openai
set OPENAI_API_KEY=key

````bash
pnpm i
pnpm dev
```


## Selected companies

| Company                          | Ticker | Currency · Standard | Investor Relations                           |
| -------------------------------- | ------ | ------------------- | -------------------------------------------- |
| Novo Nordisk A/S                 | NVO    | DKK · IFRS          | <https://www.novonordisk.com/investors.html> |
| SAP SE                           | SAP    | EUR · IFRS          | <https://www.sap.com/investors.html>         |
| LVMH Moët Hennessy Louis Vuitton | MC     | EUR · IFRS          | <https://www.lvmh.com/en/investors>          |

## How it maps to the assignment

1. **Scrape / classify the IR PDFs** → `crawler/src/catalog.ts` renders each company's
   (JavaScript-heavy) IR archive with a real headless browser and harvests **every** PDF,
   classifying it by type. Shown in the app's **Filings** tab as a filterable catalog.
2. **Parse the annual reports for the Big Three, exactly as reported** → `crawler/src/extract.ts`.
3. **Compile one clean 10-year view per statement** → the compile step (dedup + restatement).
4. **UI + live deployment** → Next.js dashboard on Vercel.

Primary output: a table per statement with 10 years of data. Secondary output: the full
classified filing catalog. Both bonuses (dedup/ordering, restatement) are implemented.

## Architecture

Collection is **two complementary tools** — a cheap deterministic scraper does the bulk, the
expensive LLM agent only fills gaps (so it barely spends tokens):

```bash
                 ┌──────────────────────────────────────────────┐
  IR websites →  │ catalog.ts — Cloudflare Browser Run (headless │  ← renders JS archives,
                 │ Chrome). Scrapes ALL PDFs, classifies by type │    no LLM
                 └───────────────┬──────────────────────────────┘
                                 │  writes
                    lib/data/filings.ts (Document Catalog)
                    cache/discovered.json (Annual-Report URLs)
                                 │
             (year missing?) →   ▼
                 ┌──────────────────────────────────────────────┐
                 │ discover.ts — LLM agent, web search fallback  │  ← only for gaps
                 └───────────────┬──────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │ extract.ts                                    │
                 │  • download + parse PDF (unpdf)               │
                 │  • locate statements (deterministic           │
                 │    signatures + LLM for income)               │
                 │  • LLM transcribes each statement table       │
                 │  • compile: merge reports, dedup labels,      │
                 │    latest-value-wins (restatement)            │
                 │  • validate accounting identities             │
                 └───────────────┬──────────────────────────────┘
                                 ▼
                    lib/data/<slug>.ts  →  Next.js dashboard  →  Vercel
````

### Design decisions worth calling out

- **Deterministic statement locators.** Finding _which_ of a report's hundreds of pages holds
  each statement is the hard part. Instead of trusting the LLM, the balance sheet is located as
  "the page carrying both `total assets` **and** `total equity and liabilities`" and the cash
  flow as "the page with operating + investing + financing activities **and** ending cash." This
  avoids summary/"selected financial data" tables the LLM otherwise grabs, is provider-independent
  (no tokens), and was verified across all 40 company-years. `--pages` is a manual escape hatch.
- **As-reported values, deduplicated labels.** Companies rename line items across years
  (`Net profit` vs `Net profit for the year`, `Total assets(3)` footnotes, hyphen variants). A
  normalised key merges those onto one row while the **displayed** label keeps the latest report's
  wording — so values stay exactly as reported but the table isn't cluttered (**bonus 1**).
- **Restatement — latest per period.** Every column of every report is extracted; for each period
  the value from the newest report wins, and restated cells are flagged (underlined in the UI)
  (**bonus 2**).
- **Validation.** Deterministic accounting checks: the balance sheet balances (fail), net income
  ties across income & cash-flow (fail), ending cash vs balance-sheet cash (warning — the two
  legitimately differ by bank overdrafts under IAS 7).
- **Scope.** English-language IFRS or US-GAAP reports; non-English is skipped before any LLM spend.

## Notes & future work

**Done** (see _Architecture_ above): automatic PDF collection via headless-browser scrape,
an agentic discovery fallback (the LLM picks tools — web search / fetch page / list PDF links —
as JSON actions, so it's provider-agnostic, not tied to one vendor's function-calling API),
English-language + IFRS/US-GAAP scope detection, deterministic statement location, label
deduplication with restatement, and cross-statement validation (`validateStatements`) covering
all three statements.

**Considered / future:**

- **Scheduled refreshes.** A GitHub Action cron keyed to each company's earnings date, persisting
  `crawler/cache/` (via `actions/cache`) so scheduled runs re-spend no LLM/browser quota — only
  new reports hit the pipeline.
- **Exhaustive archive scraping.** Some IR archives paginate ("load more" / infinite scroll); the
  single `/links` render captures the first screen. A Puppeteer session (scroll + click) through
  Browser Run would harvest the full document history.
- **Cross-company canonical taxonomy.** Optionally map each filer's line items onto a standard
  chart of accounts (Revenue, COGS, Operating income, …) for side-by-side comparison — kept off by
  default so the tables stay _exactly as reported_.
- **Confidence-based retries on the income locator.** The balance-sheet and cash-flow locators are
  deterministic; the income statement is still LLM-located, so a low-confidence pick could retry or
  fall back to a signature (revenue + EPS, disambiguated from the early summary tables).

## Running

```bash
pnpm i
pnpm dev            # the dashboard
```

Crawler (in `crawler/`, uses `crawler/.env`, gitignored):

```bash
# 1. Scrape + classify all IR PDFs (Cloudflare Browser Run — token needs "Browser Rendering")
pnpm run catalog                       # all companies
pnpm run catalog -- --company sap      # one

# 2. Parse the annual reports into the 10-year statements (OpenAI / Cloudflare / Groq)
pnpm run extract -- --company "SAP SE" --years 2016-2025 --slug sap
pnpm run extract -- --check            # just test the LLM key
```

Environment (`crawler/.env`): `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Browser
Rendering + Workers AI permissions), `OPENAI_API_KEY`, and `LLM_PROVIDER` (`openai` | `cloudflare`
| `groq`). Everything expensive is cached under `crawler/cache/`, so re-runs cost nothing.

See `crawler/README.md` for the extraction pipeline in detail.

Assignment:

First, select 2 - 3 European companies (examples: Adyen, Heineken). You can hardcode the basic company info (e.g., name, ticker, investor relations website).

For each company:

Scrape/classify the PDFs on the company’s investor relations website

Parse the company’s Annual reports for the big three statements (Income Statement, Balance Sheet, & Cash Flow Statement) with the aim to extract all data exactly as the company reports it

Compile the data from multiple reports into one clean view for 10 years of data for every statement

A quick user interface to visualize the project and data. Please deploy it on a live link that our team can review. This is important as non-technical staff making decisions on next steps will not be reviewing github repos.

Output:

The output here is a table for every statement with 10 years of data, e.g., Tesla’s Income Statementimage.png

Secondary output is you now have all the filings scraped/classified

Bonus:

When creating the clean view, a lot of similarly named items will create a massive and cluttered table, so it’s best to deduplicate and order things to align with the company’s latest reporting

When extracting from the 2024 report for example, it often contains data for 2023 and 2022, which restate the 2023 and 2022 report data and is therefore more up to date and important. If you extract every column of data from every report, you can use the latest data for every period.

If you have any questions at any time please respond to this thread.

Please complete this before July 31, 2026. Once complete, we will schedule a final interview to review your work.
