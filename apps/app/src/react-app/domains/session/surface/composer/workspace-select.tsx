/** @jsxImportSource react */
/**
 * 新建任务首页输入框下方的「选择工作空间」下拉。
 *
 * 只列出可见工作区；选中后由宿主切换到该工作区的新任务。
 */
import { useState } from "react";
import { Check, ChevronDown, Cloud, Folder, FolderPlus } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type HomeWorkspaceOption = {
  id: string;
  label: string;
  remote: boolean;
};

export type WorkspaceSelectProps = {
  workspaces: HomeWorkspaceOption[];
  selectedWorkspaceId: string;
  disabled?: boolean;
  onSelect: (workspaceId: string) => void;
  /** 提供时在菜单底部显示「新建工作区」。 */
  onCreateWorkspace?: () => void;
};

export function WorkspaceSelect(props: WorkspaceSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = props.workspaces.find((workspace) => workspace.id === props.selectedWorkspaceId) ?? null;
  const SelectedIcon = selected?.remote ? Cloud : Folder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={props.disabled}
            data-testid="session-home-workspace-select"
            title={t("session.home_workspace_title")}
            className={cn(
              "flex h-8 max-w-60 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12",
              open && "bg-gray-3 text-gray-12",
              props.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <SelectedIcon size={13} strokeWidth={2} className="shrink-0" />
            <span className="truncate">{selected?.label ?? t("session.home_workspace_placeholder")}</span>
            <ChevronDown size={12} className="shrink-0" />
          </button>
        }
      />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(280px,calc(100vw-2rem))] max-h-(--available-height) overflow-y-auto p-1.5 gap-0.5"
      >
        <div role="menu" className="flex flex-col gap-0.5">
          {props.workspaces.map((workspace) => {
            const active = workspace.id === props.selectedWorkspaceId;
            const Icon = workspace.remote ? Cloud : Folder;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-testid="session-home-workspace-option"
                onClick={() => {
                  setOpen(false);
                  if (!active) props.onSelect(workspace.id);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-dls-text transition-colors hover:bg-dls-hover aria-checked:bg-dls-hover"
              >
                <Icon size={14} className="shrink-0 text-dls-secondary" />
                <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
                {active ? <Check size={14} className="shrink-0" /> : null}
              </button>
            );
          })}
          {props.onCreateWorkspace ? (
            <>
              <div className="my-1 h-px bg-dls-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  props.onCreateWorkspace?.();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              >
                <FolderPlus size={14} className="shrink-0" />
                <span>{t("session.home_workspace_create")}</span>
              </button>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
