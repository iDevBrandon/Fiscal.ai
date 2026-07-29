export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 max-w-6xl items-center px-6">
        <div className="flex items-baseline gap-1">
          <img
            src="/logo.png"
            alt="Fiscal.ai"
            className="h-5 w-auto dark:invert"
          />
        </div>
      </div>
    </header>
  )
}
