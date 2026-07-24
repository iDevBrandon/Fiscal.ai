# Fiscal AI Assignment

## Installation & how to start

```bash
pnpm i
pnpm dev
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
Crawler
  |
  v
Raw PDFs
  |
  v
Parser
  |
  v
JSON / SQLite
  |
  v
Next.js Dashboard
  |
  v
Vercel Deploy
```

### 1. Document Collection

Download pdf files from the company’s investor relations website

```bash
Company
  |
  ├── Regulatory filings
  │       ├── Annual report
  │       ├── Quarterly report
  │       └── Other filings
  |
  └── Investor Relations
          ├── Earnings release
          ├── Presentation
          └── Voluntary disclosures

              ↓

        Data ingestion agent

              ↓

        Structured financial database
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
