export type RowKind = "section" | "line" | "subtotal" | "total"

export interface StatementRow {
  label: string
  kind: RowKind
  indent?: boolean
  /** number of decimal places to render (0 for whole dollars, 2 for EPS) */
  decimals?: number
  /** "shares" rows render without a $ prefix */
  unit?: "currency" | "shares"
  values: (number | null)[]
  /** indices into `values` whose figure came from a later annual report than the one that first reported that period */
  restatedIndices?: number[]
}

export interface StatementData {
  periods: string[]
  rows: StatementRow[]
}

export type StatementKind = "income" | "balance" | "cashflow"

export const statementLabels: Record<StatementKind, string> = {
  income: "Income Statement",
  balance: "Balance Sheet",
  cashflow: "Cash Flow Statement",
}

export interface Company {
  slug: string
  ticker: string
  name: string
  exchange: string
  irUrl: string
  status: "ready" | "pending"
  /** ISO currency the statements are reported in (e.g. "EUR", "DKK") */
  currency: string
  /** Accounting standard the reports follow (e.g. "IFRS", "US GAAP") */
  standard: string
}

/** Symbol shown before figures for a given ISO currency code. */
export const currencySymbols: Record<string, string> = {
  EUR: "€",
  DKK: "kr",
  USD: "$",
  GBP: "£",
  CHF: "CHF",
}

/** Document types the catalog scraper classifies IR filings into. */
export type FilingType =
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

/** One PDF scraped from a company's IR site and classified by type. */
export interface Filing {
  year: number | null
  type: FilingType
  title: string
  url: string
  /** true if this PDF was the one parsed for the 10-year statements */
  usedForExtraction?: boolean
}
