/** @jsxImportSource react */
/**
 * 新建任务首页的两部分：页面正中的机器人动图与标题，以及窗口底部输入框上方的一排办公场景。
 *
 * 只在空会话上显示；点击场景把提示词模板填入输入框，由用户修改后再发送。
 * 「定时任务」不是对话提示词，而是打开现有的自动化页面。
 */
import { useLayoutEffect, useState, type RefObject } from "react";
import { CalendarClock, FilePenLine, Lightbulb, Presentation, Search, Sheet, type LucideIcon } from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

/** 首页标题上方的 Juggle 机器人动图（透明背景，随包交付）。 */
const HOME_MASCOT_SRC = resolveExtensionIconSrc("/pets/juggle/typing.gif");

export type OfficeScenarioId = "document" | "presentation" | "data" | "research" | "plan" | "schedule";

export type OfficeScenario = {
  id: OfficeScenarioId;
  icon: LucideIcon;
  /** 有模板的场景填入输入框；没有模板的场景执行 onOpenSchedule。 */
  promptKey: string | null;
};

export const OFFICE_SCENARIOS: readonly OfficeScenario[] = [
  { id: "document", icon: FilePenLine, promptKey: "session.home_scenario_document_prompt" },
  { id: "presentation", icon: Presentation, promptKey: "session.home_scenario_presentation_prompt" },
  { id: "data", icon: Sheet, promptKey: "session.home_scenario_data_prompt" },
  { id: "research", icon: Search, promptKey: "session.home_scenario_research_prompt" },
  { id: "plan", icon: Lightbulb, promptKey: "session.home_scenario_plan_prompt" },
  { id: "schedule", icon: CalendarClock, promptKey: null },
];

/** 标题与底部区域之间至少保留的间距（px）。 */
const HOME_TITLE_MIN_GAP = 24;
/** 标题块中心所在高度占内容区的比例；需与 SessionHomeTitle 的 top-[38%] 一致。 */
const HOME_TITLE_CENTER_RATIO = 0.38;

/**
 * 判断标题能否放在容器正中而不碰到底部的场景按钮与输入框。
 * 放不下时（窗口太矮、输入框变高）返回 false，宿主改为正常排版：标题在上，底部区域在下。
 */
export function useHomeTitleCentered(
  containerRef: RefObject<HTMLElement | null>,
  bottomRef: RefObject<HTMLElement | null>,
  titleRef: RefObject<HTMLElement | null>,
): boolean {
  const [centered, setCentered] = useState(true);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const bottom = bottomRef.current;
    const title = titleRef.current;
    if (!container || !bottom || !title || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 底部区域只算实际内容高度（场景按钮 + 输入框），不算 flex 撑开的空白。
      let bottomContent = 0;
      for (const child of Array.from(bottom.children)) {
        const style = getComputedStyle(child);
        bottomContent += (child as HTMLElement).offsetHeight + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0");
      }
      const titleBottom = container.clientHeight * HOME_TITLE_CENTER_RATIO + title.offsetHeight / 2;
      setCentered(titleBottom + HOME_TITLE_MIN_GAP <= container.clientHeight - bottomContent);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(title);
    for (const child of Array.from(bottom.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [bottomRef, containerRef, titleRef]);
  return centered;
}

export type SessionHomeTitleProps = {
  appName: string;
  /** true 时绝对定位在宿主（relative 容器）偏上居中处；false 时按正常文档流排版。 */
  centered: boolean;
  className?: string;
};

/** 机器人动图与标题。 */
export function SessionHomeTitle({ ref, ...props }: SessionHomeTitleProps & { ref?: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex shrink-0 flex-col items-center gap-3 px-4",
        // 设计稿：标题块中心约在内容区 38% 高度处（偏上），而不是正中。
        props.centered ? "pointer-events-none absolute inset-x-0 top-[38%] -translate-y-1/2" : "pt-10 pb-6",
        props.className,
      )}
      data-testid="session-home-title"
      data-centered={props.centered ? "true" : "false"}
    >
      <img
        src={HOME_MASCOT_SRC}
        alt={t("session.home_mascot_alt")}
        width={120}
        height={130}
        draggable={false}
        data-testid="session-home-mascot"
        className="h-[130px] w-[120px] select-none object-contain"
      />
      <h1 className="text-center text-[28px] font-semibold tracking-[-0.01em] text-dls-text md:text-[32px]">
        {t("session.home_title", { appName: props.appName })}
      </h1>
    </div>
  );
}

export type SessionHomeScenariosProps = {
  /** 把场景模板写入输入框（不发送）。 */
  onFillPrompt: (prompt: string) => void;
  /** 打开定时任务页面；不提供时隐藏「定时任务」场景。 */
  onOpenSchedule?: () => void;
  className?: string;
};

/** 一排办公场景按钮；宿主把它放在底部输入框上方。 */
export function SessionHomeScenarios(props: SessionHomeScenariosProps) {
  const scenarios = OFFICE_SCENARIOS.filter((scenario) => scenario.promptKey !== null || props.onOpenSchedule);
  return (
    <div
      className={cn("mx-auto flex w-full max-w-[800px] flex-wrap justify-center gap-2 px-4 md:px-8", props.className)}
      role="group"
      aria-label={t("session.home_scenarios_label")}
      data-testid="session-home-scenarios"
    >
      {scenarios.map((scenario) => (
        <button
          key={scenario.id}
          type="button"
          data-testid={`session-home-scenario-${scenario.id}`}
          onClick={() => {
            if (scenario.promptKey) props.onFillPrompt(t(scenario.promptKey));
            else props.onOpenSchedule?.();
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dls-border bg-dls-surface px-3.5 text-[13px] text-dls-text transition-colors hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent/35"
        >
          <scenario.icon size={14} strokeWidth={1.8} className="text-dls-secondary" />
          {t(`session.home_scenario_${scenario.id}`)}
        </button>
      ))}
    </div>
  );
}
