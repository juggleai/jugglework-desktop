/** @jsxImportSource react */
import * as React from "react";
import { GitCompare, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FilesPanelFileTab } from "./files-panel-store";

/**
 * 标签栏里的「变更」标签
 *
 * @param label 标签文案
 * @param count 变更文件数
 * @param active 是否处于选中态
 * @param onSelect 选中回调
 */
export type ChangesTabDescriptor = {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
};

type FileTabsProps = {
  tabs: FilesPanelFileTab[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  changesTab: ChangesTabDescriptor | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

/**
 * 文件面板的标签栏：会话变更与已打开的文件共用一排标签
 *
 * @param tabs 已打开的文件标签
 * @param activePath 当前激活的文件路径，变更标签选中时传 null
 * @param dirtyPaths 存在未保存修改的文件路径集合
 * @param changesTab 会话有改动时的「变更」标签，无改动时传 null
 * @param onSelect 切换文件标签
 * @param onClose 关闭文件标签
 */
export function FileTabs({ tabs, activePath, dirtyPaths, changesTab, onSelect, onClose }: FileTabsProps) {
  if (tabs.length === 0 && !changesTab) return null;

  return (
    <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto">
      {changesTab ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={changesTab.label}
          onClick={changesTab.onSelect}
          className={cn(
            "shrink-0 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
            changesTab.active && "bg-muted/80 text-foreground",
          )}
        >
          <GitCompare className="size-3.5" />
          {changesTab.label}
          <span className="rounded-full bg-primary/15 px-1.5 text-[10px] leading-4 text-primary">{changesTab.count}</span>
        </Button>
      ) : null}
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const dirty = dirtyPaths.has(tab.path);

        return (
          // TIPS: 标签宽度跟着文件名走，最宽到 9rem 就截断——短文件名不再占满一格，
          // 长文件名也不会把标签栏撑开。
          <div key={tab.path} className="group relative min-w-0 max-w-36 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title={tab.path}
              onClick={() => onSelect(tab.path)}
              className={cn(
                "w-full min-w-0 justify-start gap-1.5 px-2 pr-7 text-left text-[13px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
                active && "bg-muted/80 text-foreground",
              )}
            >
              <span className="min-w-0 truncate">{tab.name}</span>
              {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${tab.name}`}
              className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 mac:titlebar-no-drag"
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                onClose(tab.path);
              }}
            >
              <X className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
