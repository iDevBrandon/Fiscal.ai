import type { Company } from "@/lib/types"

export const companies: Company[] = [
  {
    slug: "nvo",
    ticker: "NVO",
    name: "Novo Nordisk A/S",
    exchange: "Nasdaq Copenhagen · NYSE",
    irUrl: "https://www.novonordisk.com/investors.html",
    status: "ready",
  },
  {
    slug: "airbus",
    ticker: "AIR",
    name: "Airbus SE",
    exchange: "Euronext Paris · Frankfurt",
    irUrl: "https://www.airbus.com/en/investors",
    status: "ready",
  },
  {
    slug: "lvmh",
    ticker: "MC",
    name: "LVMH Moët Hennessy Louis Vuitton SE",
    exchange: "Euronext Paris",
    irUrl: "https://www.lvmh.com/en/investors",
    status: "ready",
  },
]
