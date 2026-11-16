/** @jsxImportSource react */
import * as React from "react";
import { Cloud, GitCompare, X, ArrowUpRight } from "lucide-react";

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
  cloudTabs?: Array<{ key: string; title: string; active: boolean; onSelect: () => void; onClose: () => void; onOpenWindow?: () => void }>;
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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const activeTabRef = React.useRef<HTMLDivElement>(null);
  const documents = [
    ...tabs.map(tab => ({ key: `file:${tab.path}`, title: tab.path, name: tab.name, active: tab.path === activePath, dirty: dirtyPaths.has(tab.path), cloud: false, openWindow: undefined as (() => void) | undefined, select: () => onSelect(tab.path), close: () => onClose(tab.path) })),
    ...cloudTabs.map(tab => ({ key: `cloud:${tab.key}`, title: `${t("cloud_docs.title")} · ${tab.title}`, name: tab.title, active: tab.active, dirty: false, cloud: true, openWindow: tab.onOpenWindow, select: tab.onSelect, close: tab.onClose })),
  ];
  const activeKey = changesTab?.active ? "changes" : documents.find(tab => tab.active)?.key;
  const layoutKey = JSON.stringify([changesTab ? [changesTab.label, changesTab.count] : null, ...documents.map(tab => [tab.key, tab.name, tab.dirty, Boolean(tab.openWindow)])]);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const revealActiveTab = () => {
      const active = activeTabRef.current;
      if (!active || container.clientWidth === 0) return;
      const right = active.offsetLeft + active.offsetWidth;
      const visibleRight = container.scrollLeft + container.clientWidth;
      // TIPS: 只滚动标签栏，避免 scrollIntoView 连带移动聊天正文或整个面板。
      if (right > visibleRight) container.scrollLeft += right - visibleRight;
      else if (active.offsetLeft < container.scrollLeft) container.scrollLeft = active.offsetLeft;
    };
    revealActiveTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKey, layoutKey]);

  if (tabs.length === 0 && !changesTab && !cloudTabs.length) return null;

  return (
    <div ref={containerRef} data-testid="file-tabs" className="no-scrollbar relative flex h-9 items-center gap-1 overflow-x-auto">
      {changesTab ? (
        <div ref={changesTab.active ? activeTabRef : undefined} data-file-tab-key="changes" className="group relative shrink-0">
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
          {changesTab.onClose ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("artifact.close_changes")} className={cn("absolute end-1 top-1/2 -translate-y-1/2 mac:titlebar-no-drag", changesTab.active ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100")} onClick={changesTab.onClose}><X className="size-3" /></Button> : null}
        </div>
      ) : null}
      {documents.map((tab) => {
        const { active, dirty } = tab;

        return (
          <div key={tab.key} ref={active ? activeTabRef : undefined} data-file-tab-key={tab.key} className="group relative min-w-0 max-w-36 shrink-0" data-testid="file-tab">
            {tab.openWindow && <Button type="button" variant="ghost" size="icon-xs" title={t("artifact.open_window")} aria-label={t("artifact.open_window")} className="absolute end-6 top-1/2 z-10 -translate-y-1/2 pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 mac:titlebar-no-drag" onClick={tab.openWindow}><ArrowUpRight className="size-3" /></Button>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title={tab.title}
              aria-pressed={active}
              onClick={tab.select}
              className={cn(
                "w-full min-w-0 justify-start gap-1.5 px-2 pr-8 text-left text-[13px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
                active && "bg-muted/80 text-foreground",
                tab.openWindow && "pr-14",
              )}
            >
              {tab.cloud && <Cloud className="size-3.5 shrink-0" aria-hidden="true" />}
              <FileTabLabel name={tab.name} />
              {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("session_files.close_file", { name: tab.name })}
              data-active={active ? "true" : "false"}
              className={cn(
                "absolute end-1 top-1/2 z-10 -translate-y-1/2 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground mac:titlebar-no-drag",
                active
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100",
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

/** 长标题只让尾部渐隐，短标题完整显示，关闭按钮不参与遮罩。 */
function FileTabLabel({ name }: { name: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [name]);
  return <span ref={ref} className="file-tab-label min-w-0 overflow-hidden whitespace-nowrap" data-overflow={overflow ? "true" : undefined}>{name}</span>;
}
