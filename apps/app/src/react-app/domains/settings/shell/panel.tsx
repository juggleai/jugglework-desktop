/** @jsxImportSource react */
import type * as React from "react";
import { RefreshCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type SettingsContentProps = {
  children: React.ReactNode;
  /**
   * 紧凑模式：会话右侧「项目设置」面板使用。
   * TIPS: 常规内边距是按视口断点（md/lg）放大的，在窄侧栏里会叠加成左右各 32px 的空白，
   * 紧凑模式交由内容自己控制留白，并且横向撑满而非居中。
   */
  compact?: boolean;
};

export function SettingsContent(props: SettingsContentProps) {
  return (
    <div
      className={cn(
        "min-w-0 min-h-0 flex-1 overflow-y-auto flex flex-col",
        props.compact ? "gap-3 items-stretch" : "gap-6 p-4 md:gap-8 md:p-6 lg:p-8 items-center",
      )}
    >
      {props.children}
    </div>
  );
}

type SettingsPanelProps = {
  children: React.ReactNode;
};

export function SettingsPanel(props: SettingsPanelProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 md:flex-row md:items-center md:justify-between lg:max-w-3xl w-full",
      )}
    >
      {props.children}
    </div>
  );
}

type SettingsPanelHeadingProps = {
  children: React.ReactNode;
  className?: string;
};

export function SettingsPanelHeading(props: SettingsPanelHeadingProps) {
  return <div className={cn("flex flex-col gap-y-1", props.className)}>{props.children}</div>;
}

type SettingsPanelTitleProps = {
  children: React.ReactNode;
  className?: string;
};

export function SettingsPanelTitle(props: SettingsPanelTitleProps) {
  return <h2 className={cn("text-xl font-semibold tracking-tight", props.className)}>{props.children}</h2>;
}

type SettingsPanelDescriptionProps = {
  children: React.ReactNode;
};

export function SettingsPanelDescription(props: SettingsPanelDescriptionProps) {
  return <p className="text-sm text-muted-foreground">{props.children}</p>;
}

type SettingsPanelToolbarProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbar(props: SettingsPanelToolbarProps) {
  return <div className="mt-4 flex flex-col gap-y-2 md:mt-0 md:max-w-sm md:text-right">{props.children}</div>;
}

type SettingsPanelToolbarActionsProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbarActions(props: SettingsPanelToolbarActionsProps) {
  return <div className="flex flex-wrap items-center gap-2 md:justify-end">{props.children}</div>;
}

type SettingsPanelToolbarStatusProps = {
  tone?: string;
  title?: string;
  spinning?: boolean;
  children: React.ReactNode;
};

export function SettingsPanelToolbarStatus(props: SettingsPanelToolbarStatusProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm",
        props.tone ?? "bg-gray-4/60 text-gray-11 border-gray-7/50",
      )}
      title={props.title}
    >
      {props.spinning ? <RefreshCcw size={12} className="animate-spin" /> : null}
      <span className="tabular-nums whitespace-nowrap">{props.children}</span>
    </div>
  );
}

type SettingsPanelToolbarButtonProps = {
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
};

export function SettingsPanelToolbarButton(props: SettingsPanelToolbarButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </Button>
  );
}

type SettingsPanelToolbarMessageProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbarMessage(props: SettingsPanelToolbarMessageProps) {
  return <div className="text-xs leading-relaxed text-amber-11/90 md:max-w-sm">{props.children}</div>;
}
