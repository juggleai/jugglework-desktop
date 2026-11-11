/** @jsxImportSource react */
import * as React from "react";
import { Cloud, GitCompare, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
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
  onClose?: () => void;
};

type FileTabsProps = {
  tabs: FilesPanelFileTab[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  changesTab: ChangesTabDescriptor | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** 云文档与本地文件共用标签样式和横向滚动容器。 */
  cloudTabs?: Array<{ key: string; title: string; active: boolean; onSelect: () => void; onClose: () => void }>;
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
export function FileTabs({ tabs, activePath, dirtyPaths, changesTab, onSelect, onClose, cloudTabs = [] }: FileTabsProps) {
  if (tabs.length === 0 && !changesTab && !cloudTabs.length) return null;
  const documents = [
    ...tabs.map(tab => ({ key: `file:${tab.path}`, title: tab.path, name: tab.name, active: tab.path === activePath, dirty: dirtyPaths.has(tab.path), cloud: false, select: () => onSelect(tab.path), close: () => onClose(tab.path) })),
    ...cloudTabs.map(tab => ({ key: `cloud:${tab.key}`, title: `${t("cloud_docs.title")} · ${tab.title}`, name: tab.title, active: tab.active, dirty: false, cloud: true, select: tab.onSelect, close: tab.onClose })),
  ];

  return (
    <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto">
      {changesTab ? (
        <div className="relative shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={changesTab.label}
            onClick={changesTab.onSelect}
            className={cn(
              "shrink-0 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
              changesTab.active && "bg-muted/80 text-foreground",
              changesTab.onClose && "pr-7",
            )}
          >
            <GitCompare className="size-3.5" />
            {changesTab.label}
            <span className="rounded-full bg-primary/15 px-1.5 text-[10px] leading-4 text-primary">{changesTab.count}</span>
          </Button>
          {changesTab.onClose ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("artifact.close_changes")} className="absolute end-1 top-1/2 -translate-y-1/2 mac:titlebar-no-drag" onClick={changesTab.onClose}><X className="size-3" /></Button> : null}
        </div>
      ) : null}
      {documents.map((tab) => {
        const { active, dirty } = tab;

        return (
          // TIPS: 标签宽度跟着文件名走，最宽到 9rem 就截断——短文件名不再占满一格，
          // 长文件名也不会把标签栏撑开。
          <div key={tab.key} className="group relative min-w-0 max-w-36 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title={tab.title}
              aria-pressed={active}
              onClick={tab.select}
              className={cn(
                "w-full min-w-0 justify-start gap-1.5 px-2 text-left text-[13px] font-normal text-muted-foreground transition-[padding] hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
                // 未选中时不为空的关闭按钮预留空间，让短标题保持紧凑；悬停或
                // 键盘进入标签后再压缩标题，以同一标签宽度显示关闭按钮。
                active
                  ? "pr-7"
                  : "pr-2 group-hover:pr-7 group-focus-within:pr-7",
                active && "bg-muted/80 text-foreground",
              )}
            >
              {tab.cloud && <Cloud className="size-3.5 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 truncate">{tab.name}</span>
              {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${tab.name}`}
              data-active={active ? "true" : "false"}
              className={cn(
                "absolute end-1 top-1/2 z-10 -translate-y-1/2 bg-muted transition-opacity mac:titlebar-no-drag",
                active
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
              )}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                tab.close();
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
