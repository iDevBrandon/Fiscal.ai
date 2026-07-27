# Fiscal AI Assignment

## Installation & how to start

```bash
pnpm i
pnpm dev
```

## Crawler error handling

```bash
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL
pnpm run extract -- --check
```

## Overall

A brief explanation of the Fiscal AI assessment, its purpose, and the goal of the project.

## Selected Companies

| Company      | Ticker | Investor Relations Website                   |
| ------------ | ------ | -------------------------------------------- |
| ASML         | ASML   | <https://www.asml.com/en/investors>          |
| Novo Nordisk | NVO    | <https://www.novonordisk.com/investors.html> |
| SAP          | SAP    | <https://www.sap.com/investors.html>         |

## Workflow

```bash
Company Config (ASML/NVO/SAP)
    |
    v
IR Crawler
    |
    v
Temporary File System
(raw PDFs)
    |
    v
PDF Extractor
(text/table extraction)
    |
    v
LLM Extraction
(structured JSON)
    |
    v
LLM Cache
(PDF hash -> extracted JSON)
    |
    v
Validation / Reconciliation
    |
    v
Normalization
    |
    v
lib/data/*.json
(version controlled dataset)
    |
    v
Next.js Dashboard
    |
    v
Vercel
```

## Things to consider

- [ ] Getting company's earning date to run cron job with Github action
- [ ] Fetch PDFs automactically with company's IR
- [ ] Built a filing discovery agent that normalizes financial filings using tool calling, since each company's IR website has a different structure and PDF url format
- [ ] Is the Report written in English/Non-English & follow which Accounting Principles (U.S. GAAP vs. International Standards (IFRS))
- [ ] Added ignore-list filtering and section windowing to `classifyPages()` to select consolidated financial statements while excluding notes, supplementary statements, and separate/local GAAP reports.
- [ ] section locator LLM confidence is less than 0.6, it will retry automatically

## Validation & testing

### 1. Document Collection

Download pdf files from the company’s investor relations website

```bash
                Company Name
                     |
                     v
              Discovery Agent
                     |
          Find Annual Report URL
                     |
                     v
                  PDF
                     |
                     v
             PDF Extraction
                     |
                     v
        Statement Classification Agent
                     |
       --------------------------------
       |              |               |
 Income Statement  Balance Sheet  Cash Flow
       |              |               |
       --------------------------------
                     |
                     v
             Financial Normalizer
                     |
                     v
               Big Three JSON
```

### 2. Financial Statement Extraction

- Income Statement
- Balance Sheet
- Cash Flow Statement

### 3. Data Consolidation

combined into a unified dataset covering 10 years of historical data

### 4. Visualization

## Live Demo

[Deployment URL](https://fiscal-ai-web.vercel.app/)

---

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

OpenAI Key
