import type { StatementData } from "@/lib/types"

// Placeholder dataset transcribed from the target output format (Tesla's
// income statement) purely to validate table design before real ASML /
// Novo Nordisk / SAP data is wired in. Two source rows that were entirely
// blank across all six periods ("... - Basic and Diluted" duplicates of the
// per-share and share-count sections below) were dropped here — a preview
// of the dedup behavior the real compile pipeline will apply across years
// of filings.
export const teslaIncomeStatement: StatementData = {
  periods: [
    "Dec 31, 2024",
    "Dec 31, 2023",
    "Dec 31, 2022",
    "Dec 31, 2021",
    "Dec 31, 2020",
    "Dec 31, 2019",
  ],
  rows: [
    { label: "Revenues", kind: "section", values: [] },
    { label: "Automotive Sales", kind: "line", values: [72480, 78509, 67210, 44125, 24604, 19358] },
    { label: "Development Services", kind: "line", values: [null, null, null, null, null, null] },
    { label: "Automotive Regulatory Credits", kind: "line", values: [2763, 1790, 1776, 1465, 1580, 594] },
    { label: "Automotive Leasing", kind: "line", values: [1827, 2120, 2476, 1642, 1052, 869] },
    {
      label: "Total Automotive Revenues",
      kind: "subtotal",
      values: [77070, 82419, 71462, 47232, 27236, 20821],
      restatedIndices: [1],
    },
    { label: "Energy Generation and Storage", kind: "line", values: [10086, 6035, 3909, 2789, 1994, 1531] },
    { label: "Services and Other", kind: "line", values: [10534, 8319, 6091, 3802, 2306, 2226] },
    { label: "Total Revenues", kind: "total", values: [97690, 96773, 81462, 53823, 31536, 24578] },

    { label: "Cost of Revenues", kind: "section", values: [] },
    { label: "Automotive Sales", kind: "line", values: [61870, 65121, 49599, 32415, 19696, 15939] },
    { label: "Development Services", kind: "line", values: [null, null, null, null, null, null] },
    { label: "Automotive Leasing", kind: "line", values: [1003, 1268, 1509, 978, 563, 459] },
    {
      label: "Total Automotive Cost of Revenues",
      kind: "subtotal",
      values: [62873, 66389, 51108, 33393, 20259, 16398],
    },
    { label: "Energy Generation and Storage", kind: "line", values: [7446, 4894, 3621, 2918, 1976, 1341] },
    { label: "Services and Other", kind: "line", values: [9921, 7830, 5880, 3906, 2671, 2770] },
    { label: "Total Cost of Revenues", kind: "total", values: [80240, 79113, 60609, 40217, 24906, 20509] },

    {
      label: "Gross Profit",
      kind: "total",
      values: [17450, 17660, 20853, 13606, 6630, 4069],
      restatedIndices: [2],
    },

    { label: "Operating Expenses", kind: "section", values: [] },
    { label: "Research and Development", kind: "line", values: [4540, 3969, 3075, 2593, 1491, 1343] },
    { label: "Selling, General and Administrative", kind: "line", values: [5150, 4800, 3946, 4517, 3145, 2646] },
    { label: "Restructuring and Other", kind: "line", values: [684, null, 176, -27, null, 149] },
    { label: "Total Operating Expenses", kind: "subtotal", values: [10374, 8769, 7197, 7083, 4636, 4138] },

    { label: "Income from Operations", kind: "total", values: [7076, 8891, 13656, 6523, 1994, -69] },
    { label: "Interest Income", kind: "line", values: [1569, 1066, 297, 56, 30, 44] },
    { label: "Interest Expense", kind: "line", values: [-350, -156, -191, -371, -748, -685] },
    { label: "Other Income, Net", kind: "line", values: [695, 172, -43, 135, -122, 45] },
    { label: "Income Before Income Taxes", kind: "total", values: [8990, 9973, 13719, 6343, 1154, -665] },
    { label: "Provision for Income Taxes", kind: "line", values: [1837, -5001, 1132, 699, 292, 110] },
    { label: "Net Income", kind: "total", values: [7153, 14974, 12587, 5644, 862, -775] },
    {
      label: "Net Income Attributable to Noncontrolling Interests",
      kind: "line",
      values: [62, -23, 31, 125, 141, 87],
    },
    {
      label: "Net Income Attributable to Common Stockholders",
      kind: "total",
      values: [7091, 14997, 12556, 5519, 721, -862],
    },

    { label: "Net Income per Share — Basic", kind: "section", values: [] },
    { label: "Basic", kind: "line", decimals: 2, values: [2.23, 4.73, 4.02, 1.87, 0.25, -0.33] },
    { label: "Diluted", kind: "line", decimals: 2, values: [2.04, 4.3, 3.62, 1.63, 0.21, -0.33] },

    { label: "Weighted Average Shares Outstanding", kind: "section", values: [] },
    { label: "Basic", kind: "line", unit: "shares", values: [3197, 3174, 3130, 2959, 2798, 2661] },
    { label: "Diluted", kind: "line", unit: "shares", values: [3498, 3485, 3475, 3386, 3249, 2661] },
  ],
}
