/** @jsxImportSource react */
import type { ReactNode } from "react";
import { ChevronRight, Package } from "lucide-react";

/** Catalog content only: the parent keeps category/installed navigation mounted. */
export function CatalogDetailPage(props: {
  categoryLabel: string;
  name: string;
  onBack: () => void;
  children: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="min-h-full min-w-0" data-testid="catalog-detail-page">
      <nav aria-label={props.categoryLabel} className="mb-8 flex min-w-0 items-center gap-3 text-sm">
        <button type="button" onClick={props.onBack} className="shrink-0 rounded text-dls-secondary hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/30">{props.categoryLabel}</button>
        <ChevronRight size={14} className="shrink-0 text-dls-secondary" aria-hidden />
        <span aria-current="page" className="truncate text-dls-text">{props.name}</span>
      </nav>
      <div className="mx-auto w-full max-w-[880px] space-y-7 pb-10 pt-2 md:pt-6">
        <header className="space-y-4">
          <div className="flex size-16 items-center justify-center rounded-2xl border border-dls-border bg-dls-surface [&>svg]:size-8">{props.icon ?? <Package aria-hidden />}</div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-2xl font-semibold tracking-tight text-dls-text">{props.name}</h1>
              {props.description ? <div className="mt-2 text-sm leading-6 text-dls-secondary">{props.description}</div> : null}
            </div>
            {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
          </div>
        </header>
        {props.children}
      </div>
    </section>
  );
}
