/** @jsxImportSource react */
import type { PointerEventHandler } from "react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * Dedicated app surfaces share the workspace sidebar width, but do not use the
 * shadcn Sidebar container. This handle gives those surfaces the same resize
 * interaction while keeping the persisted width in the workspace shell store.
 */
export function AppSecondarySidebarResizeHandle(props: {
  resizing: boolean;
  onPointerDown: PointerEventHandler<HTMLElement>;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("session.resize_workspace_column")}
      title={t("session.resize_workspace_column")}
      onPointerDown={props.onPointerDown}
      className="group absolute inset-y-0 z-40 hidden w-3 -translate-x-1/2 touch-none select-none bg-transparent md:block mac:titlebar-no-drag"
      style={{
        left: "var(--jugglework-left-sidebar-width)",
        // 与本地工作区 SidebarRail 保持一致，并覆盖全局 button 的 pointer 光标。
        cursor: "col-resize",
      }}
      data-app-secondary-sidebar-resize-handle
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-dls-accent/55",
          props.resizing && "bg-dls-accent",
        )}
      />
    </div>
  );
}
