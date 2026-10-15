/** @jsxImportSource react */
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { LayoutSectionDescription, LayoutSectionHeader, LayoutSectionTitle } from "../settings-layout";
import { SettingsListSearchInput } from "../settings-list";

export type CatalogSource = "public" | "organization" | "personal";

export function CatalogSourceTabs({ value, onChange, organizationName }: {
  value: CatalogSource;
  onChange: (source: CatalogSource) => void;
  organizationName?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(["public", "organization", "personal"] as const).map((source) => (
        <button
          key={source}
          type="button"
          aria-pressed={value === source}
          onClick={() => onChange(source)}
          className={cn(
            "max-w-full rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/40",
            value === source
              ? "border-transparent bg-dls-active text-dls-text"
              : "border-transparent text-dls-secondary hover:bg-dls-hover hover:text-dls-text",
          )}
        >
          <span className="block truncate">
            {source === "organization" ? organizationName?.trim() || t("customization.source_organization") : t(`customization.source_${source}`)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function CatalogHeader(props: {
  title: string;
  description: string;
  busy: boolean;
  onRefresh: () => void;
  source?: CatalogSource;
  onSourceChange?: (source: CatalogSource) => void;
  organizationName?: string | null;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  actions?: ReactNode;
}) {
  return (
    <LayoutSectionHeader>
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 flex-1">
          <LayoutSectionTitle>{props.title}</LayoutSectionTitle>
          <LayoutSectionDescription className="mt-1 min-h-10 line-clamp-2" >{props.description}</LayoutSectionDescription>
        </div>
        <div className="flex w-full items-center gap-2 xl:w-auto">
          {props.search ? (
            <div className="min-w-0 flex-1 sm:w-56">
              <SettingsListSearchInput
                type="search"
                value={props.search.value}
                onChange={(event) => props.search?.onChange(event.currentTarget.value)}
                placeholder={props.search.placeholder}
                aria-label={props.search.placeholder}
              />
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.busy}
            onClick={props.onRefresh}
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
          >
            <RefreshCw className={props.busy ? "size-4 animate-spin" : "size-4"} />
          </Button>
          {props.actions}
        </div>
      </div>
      {props.source ? (
        <div className="mt-4">
          <CatalogSourceTabs
            value={props.source}
            onChange={(source) => props.onSourceChange?.(source)}
            organizationName={props.organizationName}
          />
        </div>
      ) : null}
    </LayoutSectionHeader>
  );
}
