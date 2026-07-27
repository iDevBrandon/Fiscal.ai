"use client"

import { FileClock } from "lucide-react"
import { useMemo, useState } from "react"

import { StatementTable } from "@/components/statement-table"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { companies } from "@/lib/companies"
import {
  balanceSheet as nvoBalance,
  cashFlowStatement as nvoCashflow,
  incomeStatement as nvoIncome,
} from "@/lib/data/novonordisk"
import {
  balanceSheet as airbusBalance,
  cashFlowStatement as airbusCashflow,
  incomeStatement as airbusIncome,
} from "@/lib/data/airbus"
import {
  statementLabels,
  type StatementData,
  type StatementKind,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const statementData: Record<
  string,
  Partial<Record<StatementKind, StatementData>>
> = {
  nvo: {
    income: nvoIncome,
    balance: nvoBalance,
    cashflow: nvoCashflow,
  },
  airbus: {
    income: airbusIncome,
    balance: airbusBalance,
    cashflow: airbusCashflow,
  },
}

export function FinancialExplorer() {
  const [companySlug, setCompanySlug] = useState("nvo")
  const [statement, setStatement] = useState<StatementKind>("income")

  const company = useMemo(
    () => companies.find((c) => c.slug === companySlug) ?? companies[0],
    [companySlug]
  )
  const data = statementData[companySlug]?.[statement]

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
            {c.status === "pending" && (
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  c.slug === companySlug
                    ? "bg-background/60"
                    : "bg-muted-foreground/50"
                )}
              />
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {company.name}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {company.exchange}
          </p>
        </div>
        <Tabs
          value={statement}
          onValueChange={(v) => setStatement(v as StatementKind)}
        >
          <TabsList>
            {(Object.keys(statementLabels) as StatementKind[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {statementLabels[key]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <Separator />

      {data ? (
        <StatementTable data={data} />
      ) : (
        <EmptyState
          irUrl={company.irUrl}
          message="Filings haven't been scraped and parsed for this company yet."
        />
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
