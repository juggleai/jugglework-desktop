/** @jsxImportSource react */
import type { Ref } from "react";
import { Search, X } from "lucide-react";
import { t } from "@/i18n";

import { isMacPlatform } from "@/app/utils";

import "./list-panel-header.css";

export type ListPanelHeaderProps = {
  title: string;
  searchValue: string;
  searchPlaceholder: string;
  searchInputRef?: Ref<HTMLInputElement>;
  onSearchChange: (value: string) => void;
  onSearchKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  onClearSearch: () => void;
  showClear?: boolean;
  shortcut?: string;
  searchEnd?: React.ReactNode;
  titleEnd?: React.ReactNode;
  addControl: React.ReactNode;
};

export function ListPanelHeader(props: ListPanelHeaderProps) {
  return (
    <header className={`jw-list-panel-header${isMacPlatform() ? " is-mac" : ""}`}>
      <div className="jw-list-panel-title-row">
        <h2 className="jw-list-panel-title">{props.title}</h2>
        {props.titleEnd ? <div className="jw-list-panel-title-end">{props.titleEnd}</div> : null}
      </div>
      <div className="jw-list-panel-search-row">
        <div className="jw-list-panel-search">
          <Search aria-hidden="true" />
          <input
            ref={props.searchInputRef}
            type="search"
            value={props.searchValue}
            onChange={(event) => props.onSearchChange(event.currentTarget.value)}
            onKeyDown={props.onSearchKeyDown}
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
          />
          <span className="jw-list-panel-search-end">
            {props.showClear ? (
              <button type="button" className="jw-list-panel-clear" onClick={props.onClearSearch} title={t("common.clear_search")} aria-label={t("common.clear_search")}><X /></button>
            ) : props.searchEnd ?? (props.shortcut ? <kbd className="jw-list-panel-shortcut">{props.shortcut}</kbd> : null)}
          </span>
        </div>
        <div className="jw-list-panel-add-slot">{props.addControl}</div>
      </div>
    </header>
  );
}
