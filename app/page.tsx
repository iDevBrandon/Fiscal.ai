import { SiteHeader } from "@/components/site-header"
import { FinancialExplorer } from "@/components/financial-explorer"

export default function Page() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <FinancialExplorer />
      </main>
    </div>
  )
}
