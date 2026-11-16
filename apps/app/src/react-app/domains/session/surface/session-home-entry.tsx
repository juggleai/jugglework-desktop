/** @jsxImportSource react */
/**
 * 未选中会话时的新建任务首页。
 *
 * 外观与空会话首页一致（标题、办公场景、居中输入框、工作区下拉），但此时还没有会话，
 * 所以这里的输入框只是入口：按 Enter 或发送按钮时新建任务，并把文字带进新任务的输入框；
 * 点击场景则新建任务并填入对应模板。两者都不会自动发送。
 */
import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SessionHomeScenarios, SessionHomeTitle, useHomeTitleCentered } from "./session-home-hero";
import { WorkspaceSelect } from "./composer/workspace-select";
import type { SessionHomeOptions } from "./session-surface";

export type SessionHomeEntryProps = {
  appName: string;
  workspaceId: string;
  home: SessionHomeOptions;
  /** 新建任务；prompt 写入新任务的输入框草稿。 */
  onCreateTask: (prompt?: string) => void;
  disabled?: boolean;
  /** 显示在输入框下方，例如「连接模型服务商」提示。 */
  children?: React.ReactNode;
};

export function SessionHomeEntry(props: SessionHomeEntryProps) {
  const [text, setText] = useState("");
  const startedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const titleCentered = useHomeTitleCentered(rootRef, bottomRef, titleRef);

  const start = (prompt?: string) => {
    if (props.disabled || startedRef.current) return;
    startedRef.current = true;
    props.onCreateTask(prompt?.trim() ? prompt : undefined);
    // 创建失败时允许再次尝试；成功后本组件会被会话页替换。
    window.setTimeout(() => { startedRef.current = false; }, 1500);
  };

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto" data-testid="session-home-entry">
      {/* 与会话内首页一致：标题在内容区偏上居中，场景按钮和输入框贴底。 */}
      <SessionHomeTitle ref={titleRef} appName={props.appName} centered={titleCentered} />
      <div ref={bottomRef} className="relative z-10 flex min-h-0 flex-1 flex-col justify-end pb-[4vh]" data-session-home-bottom="true">
      <SessionHomeScenarios className="mb-3 shrink-0" onFillPrompt={(prompt) => start(prompt)} onOpenSchedule={props.home.onOpenSchedule} />
      <div className="shrink-0 px-4 pb-2 md:px-8">
        <div className="mx-auto max-w-[800px]">
          <div
            className={cn(
              "relative rounded-[24px] border border-dls-border bg-dls-surface shadow-[0_10px_30px_rgba(15,23,42,0.1)] dark:shadow-[0_14px_36px_rgba(0,0,0,0.3)]",
              props.disabled && "opacity-60",
            )}
          >
            <textarea
              data-testid="session-home-entry-input"
              aria-label={t("composer.home_placeholder")}
              placeholder={t("composer.home_placeholder")}
              disabled={props.disabled}
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                start(text);
              }}
              className="block w-full resize-none bg-transparent px-4 pt-4 pb-12 text-[14px] leading-6 text-dls-text outline-none placeholder:text-dls-secondary"
            />
            <button
              type="button"
              data-testid="session-home-entry-submit"
              aria-label={t("session.home_entry_start")}
              disabled={props.disabled}
              onClick={() => start(text)}
              className={cn(
                "absolute right-4 bottom-3 flex size-9 items-center justify-center rounded-full transition-colors",
                text.trim() ? "bg-dls-text text-dls-surface" : "bg-dls-hover text-dls-secondary",
              )}
            >
              <ArrowUp size={16} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1 px-1" data-testid="session-home-entry-footer">
            <WorkspaceSelect
              workspaces={props.home.workspaces}
              selectedWorkspaceId={props.workspaceId}
              onSelect={props.home.onSelectWorkspace}
              onCreateWorkspace={props.home.onCreateWorkspace}
            />
          </div>
          {props.children ? <div className="mt-4">{props.children}</div> : null}
        </div>
      </div>
      </div>
    </div>
  );
}
