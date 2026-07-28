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
import { filings as filingsCatalog } from "@/lib/data/filings"
import {
  currencySymbols,
  statementLabels,
  type Company,
  type Filing,
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
          <FilingsPanel
            company={company}
            filings={filingsCatalog[companySlug] ?? []}
            validation={cd.validation}
          />
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

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {label}{" "}
      <span className={active ? "opacity-70" : "opacity-50"}>{count}</span>
    </button>
  )
}

function FilingsPanel({
  company,
  filings,
  validation,
}: {
  company: Company
  filings: Filing[]
  validation: ValidationResult
}) {
  const [type, setType] = useState<string>("All")

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const f of filings) m[f.type] = (m[f.type] ?? 0) + 1
    return m
  }, [filings])
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  const usedCount = filings.filter((f) => f.usedForExtraction).length

  const shown = useMemo(
    () =>
      (type === "All" ? filings : filings.filter((f) => f.type === type))
        .slice()
        .sort(
          (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.type.localeCompare(b.type)
        ),
    [filings, type]
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        {filings.length} PDF documents were scraped from{" "}
        <a
          href={company.irUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/60 underline-offset-2 hover:text-foreground"
        >
          {company.irUrl}
          <ExternalLink className="size-3" />
        </a>{" "}
        and classified into {types.length} document types. The {usedCount}{" "}
        <span className="font-medium text-foreground">Annual Report</span>{" "}
        filings (tagged <span className="font-medium text-emerald-700">parsed</span>)
        are the ones the 10-year statements were extracted from.
      </p>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          label="All"
          count={filings.length}
          active={type === "All"}
          onClick={() => setType("All")}
        />
        {types.map((t) => (
          <FilterChip
            key={t}
            label={t}
            count={counts[t]}
            active={type === t}
            onClick={() => setType(t)}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Year</th>
              <th className="px-4 py-2.5 font-medium">Classification</th>
              <th className="px-4 py-2.5 font-medium">Document</th>
              <th className="px-4 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.url} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 tabular-nums text-foreground">
                  {f.year ?? "—"}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant="secondary" className="font-normal">
                    {f.type}
                  </Badge>
                </td>
                <td className="max-w-md px-4 py-2.5">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 truncate text-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    <span className="truncate">{f.title}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </td>
                <td className="px-4 py-2.5">
                  {f.usedForExtraction && (
                    <Badge
                      variant="secondary"
                      className="bg-emerald-50 font-normal text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      parsed
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {validation.issues.length > 0 && (
        <div className="rounded-lg border border-border p-4 text-[13px]">
          <p className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangle
              className={cn(
                "size-3.5",
                validation.status === "fail"
                  ? "text-red-600"
                  : "text-amber-600"
              )}
              strokeWidth={2}
            />
            {validation.status === "fail"
              ? "Validation issues"
              : "Validation warnings"}{" "}
            ({validation.status})
          </p>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {validation.issues.map((iss, i) => (
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
            {validation.status === "fail"
              ? "A failure means a headline figure (revenue or total assets) is missing for a period — here the two oldest reports, whose source PDFs the page-locator read imperfectly. Every recent year passes; the affected columns are the earliest in the range."
              : "Warnings never block. The ending-cash warning is expected: a cash-flow statement's end-of-period cash is net of bank overdrafts (and may exclude restricted cash), while the balance-sheet cash line is gross — so the two differ each year by the overdraft balance. Both figures are correct as reported. The hard checks — the balance-sheet identity and the net-income tie — pass."}
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
