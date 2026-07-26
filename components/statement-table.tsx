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

function formatValue(row: StatementRow, value: number | null) {
  if (value === null) return "—"
  const decimals = row.decimals ?? 0
  const formatted = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  const prefix = row.unit === "shares" ? "" : "$"
  return value < 0 ? `-${prefix}${formatted}` : `${prefix}${formatted}`
}

function StatementRowView({
  row,
  periodCount,
}: {
  row: StatementRow
  periodCount: number
}) {
  if (row.kind === "section") {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell
          colSpan={periodCount + 1}
          className="sticky left-0 z-10 bg-background pt-6 pb-1.5 text-[13px] font-semibold text-foreground first:pt-2"
        >
          {row.label}
        </TableCell>
      </TableRow>
    )
  }

  const isTotal = row.kind === "total" || row.kind === "subtotal"

  return (
    <TableRow className={cn(isTotal && "border-t border-border")}>
      <TableCell
        className={cn(
          "sticky left-0 z-10 min-w-[320px] bg-background text-[13px] whitespace-nowrap",
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
          "min-w-[112px] text-right text-[13px] whitespace-nowrap tabular-nums",
          isTotal ? "font-semibold text-foreground" : "text-foreground/90"
        )

        if (!restated) {
          return (
            <TableCell key={i} className={cellClass}>
              {formatValue(row, value)}
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
                {formatValue(row, value)}
              </TooltipTrigger>
              <TooltipContent>Restated in a later annual report</TooltipContent>
            </Tooltip>
          </TableCell>
        )
      })}
    </TableRow>
  )
}

export function StatementTable({ data }: { data: StatementData }) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
      <Table className="border-separate border-spacing-0">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky top-0 left-0 z-20 min-w-[320px] bg-background" />
            {data.periods.map((period) => (
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
          {data.rows.map((row, idx) => (
            <StatementRowView
              key={`${row.label}-${idx}`}
              row={row}
              periodCount={data.periods.length}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
