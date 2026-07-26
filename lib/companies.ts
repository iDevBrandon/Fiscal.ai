import type { Company } from "@/lib/types"

export const companies: Company[] = [
  {
    slug: "asml",
    ticker: "ASML",
    name: "ASML Holding N.V.",
    exchange: "Euronext Amsterdam · Nasdaq",
    irUrl: "https://www.asml.com/en/investors",
    status: "pending",
  },
  {
    slug: "nvo",
    ticker: "NVO",
    name: "Novo Nordisk A/S",
    exchange: "Nasdaq Copenhagen · NYSE",
    irUrl: "https://www.novonordisk.com/investors.html",
    status: "pending",
  },
  {
    slug: "sap",
    ticker: "SAP",
    name: "SAP SE",
    exchange: "Deutsche Börse · NYSE",
    irUrl: "https://www.sap.com/investors.html",
    status: "ready",
  },
  {
    slug: "rheinmetall",
    ticker: "RHM",
    name: "Rheinmetall AG",
    exchange: "Deutsche Börse (Xetra)",
    irUrl: "https://www.rheinmetall.com/en/investor-relations",
    status: "ready",
  },
]
