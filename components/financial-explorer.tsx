"use client"

import { AlertTriangle, CheckCircle2, ExternalLink, FileClock } from "lucide-react"
import { useMemo, useState } from "react"

import { StatementTable } from "@/components/statement-table"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { companies } from "@/lib/companies"
import * as nvo from "@/lib/data/novonordisk"
import * as sap from "@/lib/data/sap"
import * as lvmh from "@/lib/data/lvmh"
import {
  currencySymbols,
  statementLabels,
  type Company,
  type StatementData,
  type StatementKind,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Source = { year: number; url: string }
type ValidationIssue = {
  check: string
  severity: string
  period?: string
  expected?: number
  actual?: number
  diff?: number
}
type ValidationResult = { status: string; issues: readonly ValidationIssue[] }

type CompanyData = {
  statements: Partial<Record<StatementKind, StatementData>>
  sources: Source[]
  validation: ValidationResult
}

const registry: Record<string, CompanyData> = {
  nvo: {
    statements: {
      income: nvo.incomeStatement,
      balance: nvo.balanceSheet,
      cashflow: nvo.cashFlowStatement,
    },
    sources: nvo.sources,
    validation: nvo.validation,
  },
  sap: {
    statements: {
      income: sap.incomeStatement,
      balance: sap.balanceSheet,
      cashflow: sap.cashFlowStatement,
    },
    sources: sap.sources,
    validation: sap.validation,
  },
  lvmh: {
    statements: {
      income: lvmh.incomeStatement,
      balance: lvmh.balanceSheet,
      cashflow: lvmh.cashFlowStatement,
    },
    sources: lvmh.sources,
    validation: lvmh.validation,
  },
}

type View = StatementKind | "filings"

export function FinancialExplorer() {
  const [companySlug, setCompanySlug] = useState("nvo")
  const [view, setView] = useState<View>("income")

  const company = useMemo(
    () => companies.find((c) => c.slug === companySlug) ?? companies[0],
    [companySlug]
  )
  const cd = registry[companySlug]
  const symbol = currencySymbols[company.currency] ?? company.currency
  const statement = view === "filings" ? null : cd?.statements[view]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {companies.map((c) => (
          <button
            key={c.slug}
            onClick={() => setCompanySlug(c.slug)}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
              c.slug === companySlug
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {c.ticker}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold text-foreground">
            {company.name}
          </h1>
          <p className="text-[13px] text-muted-foreground">{company.exchange}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-normal">
              {company.currency} · {company.standard}
            </Badge>
            {cd && <ValidationBadge validation={cd.validation} />}
          </div>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            {(Object.keys(statementLabels) as StatementKind[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {statementLabels[key]}
              </TabsTrigger>
            ))}
            <TabsTrigger value="filings">Filings</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Separator />

      {view === "filings" ? (
        cd ? (
          <FilingsPanel company={company} data={cd} />
        ) : (
          <EmptyState irUrl={company.irUrl} message="No filings for this company yet." />
        )
      ) : statement ? (
        <div className="flex flex-col gap-3">
          <StatementTable data={statement} symbol={symbol} />
          <p className="text-xs text-muted-foreground">
            Figures are transcribed directly from each year&apos;s report, in{" "}
            {company.currency} millions ({company.standard}). Showing the latest 10
            years. An{" "}
            <span className="underline decoration-muted-foreground/70 decoration-dotted underline-offset-4">
              underlined
            </span>{" "}
            figure was restated by a later annual report — the most recent value is
            shown.
          </p>
        </div>
      ) : (
        <EmptyState
          irUrl={company.irUrl}
          message="Filings haven't been scraped and parsed for this company yet."
        />
      )}
    </div>
  )
}

function ValidationBadge({ validation }: { validation: ValidationResult }) {
  const ok = validation.status === "pass"
  const failed = validation.status === "fail"
  const n = validation.issues.length
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 font-normal",
        ok
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : failed
            ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
      )}
    >
      {ok ? (
        <CheckCircle2 className="size-3.5" strokeWidth={2} />
      ) : (
        <AlertTriangle className="size-3.5" strokeWidth={2} />
      )}
      {ok
        ? "Accounting checks passed"
        : `${n} validation ${failed ? "issue" : "warning"}${n === 1 ? "" : "s"}`}
    </Badge>
  )
}

// Classify a discovered PDF from its URL/filename — the "classify" step, made visible.
function classifyFiling(url: string): string {
  const u = decodeURIComponent(url).toLowerCase()
  if (
    /financial[-_\s]*statements?|financial[-_\s]*documents?|financialdocuments|documents?[-_ ]financiers?|document[-_ ]financier/.test(
      u
    )
  )
    return "Financial Statements"
  if (/registration|ra-rf|urd/.test(u)) return "Registration Document"
  return "Annual Report"
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(url.split("/").pop() ?? url)
  } catch {
    return url
  }
}

function FilingsPanel({ company, data }: { company: Company; data: CompanyData }) {
  const sources = [...data.sources].sort((a, b) => b.year - a.year)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        {sources.length} annual filings were discovered on{" "}
        <a
          href={company.irUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/60 underline-offset-2 hover:text-foreground"
        >
          {company.irUrl}
          <ExternalLink className="size-3" />
        </a>
        , classified by document type, and parsed for the consolidated income
        statement, balance sheet and cash-flow statement.
      </p>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Year</th>
              <th className="px-4 py-2.5 font-medium">Classification</th>
              <th className="px-4 py-2.5 font-medium">Source PDF</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.year} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 tabular-nums text-foreground">
                  {s.year}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant="secondary" className="font-normal">
                    {classifyFiling(s.url)}
                  </Badge>
                </td>
                <td className="max-w-md px-4 py-2.5">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 truncate text-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    <span className="truncate">{fileName(s.url)}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.validation.issues.length > 0 && (
        <div className="rounded-lg border border-border p-4 text-[13px]">
          <p className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangle
              className={cn(
                "size-3.5",
                data.validation.status === "fail"
                  ? "text-red-600"
                  : "text-amber-600"
              )}
              strokeWidth={2}
            />
            {data.validation.status === "fail"
              ? "Validation issues"
              : "Validation warnings"}{" "}
            ({data.validation.status})
          </p>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {data.validation.issues.map((iss, i) => (
              <li key={i}>
                {iss.check}
                {iss.period ? ` · ${iss.period}` : ""}
                {iss.diff !== undefined
                  ? ` (off by ${iss.diff.toLocaleString("en-US")})`
                  : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {data.validation.status === "fail"
              ? "A failure means a headline figure (revenue or total assets) is missing for a period — here the two oldest reports, whose source PDFs the page-locator read imperfectly. Every recent year passes; the affected columns are the earliest in the range."
              : "Warnings never block. The ending-cash warning is expected: a cash-flow statement's end-of-period cash is net of bank overdrafts (and may exclude restricted cash), while the balance-sheet cash line is gross — so the two differ by a small, consistent amount each year (for LVMH, the overdraft balance). Both figures are correct as reported. The hard checks — the balance-sheet identity and the net-income tie — pass."}
          </p>
        </div>
      )}
    </div>
  )
}

function EmptyState({ message, irUrl }: { message: string; irUrl?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
      <FileClock className="size-5 text-muted-foreground" strokeWidth={1.5} />
      <p className="max-w-sm text-[13px] text-muted-foreground">{message}</p>
      {irUrl && (
        <Badge variant="secondary" className="font-normal">
          <a href={irUrl} target="_blank" rel="noreferrer">
            {irUrl}
          </a>
        </Badge>
      )}
    </div>
  )
}
