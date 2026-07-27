import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { StatementData, StatementRow } from "@/lib/types"
import { cn } from "@/lib/utils"

function formatValue(row: StatementRow, value: number | null, symbol: string) {
  if (value === null) return "—"
  const decimals = row.decimals ?? 0
  const formatted = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  // Multi-letter symbols (kr, CHF) read better with a space; € / $ / £ hug the number.
  const prefix =
    row.unit === "shares" ? "" : symbol.length > 1 ? `${symbol} ` : symbol
  return value < 0 ? `-${prefix}${formatted}` : `${prefix}${formatted}`
}

function StatementRowView({
  row,
  periodCount,
  symbol,
}: {
  row: StatementRow
  periodCount: number
  symbol: string
}) {
  if (row.kind === "section") {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell className="sticky left-0 z-10 w-85 max-w-85 min-w-85 bg-background pt-6 pb-1.5 text-[13px] font-semibold text-foreground first:pt-2">
          {row.label}
        </TableCell>
        {Array.from({ length: periodCount }).map((_, i) => (
          <TableCell key={i} className="bg-background" />
        ))}
      </TableRow>
    )
  }

  const isTotal = row.kind === "total" || row.kind === "subtotal"

  return (
    <TableRow className={cn(isTotal && "border-t border-border")}>
      <TableCell
        className={cn(
          "sticky left-0 z-10 w-85 max-w-85 min-w-85 bg-background py-1.5 align-top text-[13px] leading-snug wrap-break-word whitespace-normal",
          row.indent ? "pl-8" : "pl-4",
          isTotal
            ? "font-semibold text-foreground"
            : "font-normal text-muted-foreground"
        )}
      >
        {row.label}
      </TableCell>
      {row.values.map((value, i) => {
        const restated = row.restatedIndices?.includes(i)
        const cellClass = cn(
          "min-w-[112px] py-1.5 text-right align-top text-[13px] whitespace-nowrap tabular-nums",
          isTotal ? "font-semibold text-foreground" : "text-foreground/90"
        )

        if (!restated) {
          return (
            <TableCell key={i} className={cellClass}>
              {formatValue(row, value, symbol)}
            </TableCell>
          )
        }

        return (
          <TableCell key={i} className={cellClass}>
            <Tooltip>
              <TooltipTrigger
                render={<span />}
                className="cursor-help underline decoration-muted-foreground/70 decoration-dotted underline-offset-4"
              >
                {formatValue(row, value, symbol)}
              </TooltipTrigger>
              <TooltipContent>Restated in a later annual report</TooltipContent>
            </Tooltip>
          </TableCell>
        )
      })}
    </TableRow>
  )
}

// Periods are newest-first; the deliverable is a 10-year view, so cap the display.
const MAX_PERIODS = 10

export function StatementTable({
  data,
  symbol = "$",
}: {
  data: StatementData
  symbol?: string
}) {
  const periods = data.periods.slice(0, MAX_PERIODS)
  const rows = data.rows.map((row) =>
    row.values ? { ...row, values: row.values.slice(0, MAX_PERIODS) } : row
  )

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
      <Table className="border-separate border-spacing-0">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky top-0 left-0 z-20 w-85 max-w-85 min-w-85 bg-background" />
            {periods.map((period) => (
              <TableHead
                key={period}
                className="sticky top-0 z-10 min-w-28 bg-background text-right text-[13px] font-semibold whitespace-nowrap text-foreground"
              >
                {period}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, idx) => (
            <StatementRowView
              key={`${row.label}-${idx}`}
              row={row}
              periodCount={periods.length}
              symbol={symbol}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
