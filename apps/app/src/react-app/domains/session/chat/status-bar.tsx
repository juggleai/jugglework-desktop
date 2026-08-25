/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, MessageCircleMore } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useControlAction, type JuggleWorkControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
import type { JuggleWorkServerStatus } from "../../../../app/lib/jugglework-server";
import { readDenSettings } from "../../../../app/lib/den";
import {
  juggleWorkConnectAttentionTitle,
  resolveJuggleWorkConnectStatus,
  type JuggleWorkConnectStatus,
} from "../../connections/jugglework-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../../connections/use-session-mcp-maintenance";

const DOCS_URL = "https://juggle.im/docs";
const STATUS_BAR_BOOT_STARTED_AT = Date.now();
const STATUS_BAR_INITIALIZING_MS = 15_000;

type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

type StatusDotProps = {
  variant: StatusDotVariant;
};

function StatusDot({ variant }: StatusDotProps) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
      {variant === "loading" ? (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full bg-amber-9/35"
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          variant === "connected" && "bg-green-9",
          variant === "loading" && "bg-amber-9",
          variant === "partial" && "bg-amber-9",
          variant === "disconnected" && "bg-red-9",
        )}
      />
    </span>
  );
}

function JuggleWorkConnectIndicator(props: {
  status: JuggleWorkConnectStatus;
  onRunDiagnostics: () => void;
}) {
  const content = (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <StatusDot
        variant={props.status.state === "ready"
          ? "connected"
          : props.status.state === "checking"
            ? "loading"
            : "disconnected"}
      />
      <span>JuggleWork Connect: {props.status.label}</span>
    </span>
  );

  if (props.status.state !== "needs_attention") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span data-testid="jugglework-connect-status" className="inline-flex" />}>{content}</TooltipTrigger>
        <TooltipContent>{props.status.description}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={(
          <button
            type="button"
            data-testid="jugglework-connect-status"
            title={juggleWorkConnectAttentionTitle(props.status.description)}
            className="rounded-md px-1.5 py-1 transition-colors hover:bg-muted"
          />
        )}
      >
        {content}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-3 rounded-xl">
        <PopoverHeader>
          <PopoverTitle>JuggleWork Connect needs attention</PopoverTitle>
          <PopoverDescription>{props.status.description}</PopoverDescription>
        </PopoverHeader>
        <Button size="sm" onClick={props.onRunDiagnostics}>Run diagnostics</Button>
      </PopoverContent>
    </Popover>
  );
}

type StatusIndicatorProps = {
  clientConnected: boolean;
  juggleworkServerStatus: JuggleWorkServerStatus;
  developerMode: boolean;
  loading?: boolean;
  initializing: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
};

function StatusIndicator(props: StatusIndicatorProps) {
  if (props.reloadBusy) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="loading" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("status.reloading_config")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {t("config.reload_now_desc")}
        </span>
      </div>
    );
  }

  if (props.reloadError) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="disconnected" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("system.reload_failed")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {props.reloadError}
        </span>
      </div>
    );
  }

  if (props.loading || (props.juggleworkServerStatus === "disconnected" && props.initializing)) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="loading" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("session.preparing_workspace")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {t("session.loading_detail")}
        </span>
      </div>
    );
  }

  if (props.clientConnected) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <StatusDot variant="connected" />
          </TooltipTrigger>
          <TooltipContent>{t("status.connected")}</TooltipContent>
        </Tooltip>
        <span className="truncate text-muted-foreground text-xs">
          {t("status.ready_for_tasks")}
        </span>
        {props.developerMode ? (
          <span className="truncate text-muted-foreground text-xs">
            {t("status.developer_mode")}
          </span>
        ) : null}
      </div>
    );
  }

  if (props.juggleworkServerStatus === "limited") {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="partial" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("status.limited_mode")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {t("status.limited_hint")}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <StatusDot variant="disconnected" />
      <span className="shrink-0 font-medium text-foreground text-xs">
        {t("status.disconnected_label")}
      </span>
      <span className="truncate text-muted-foreground text-xs">
        {t("status.disconnected_hint")}
      </span>
    </div>
  );
}

export type StatusBarProps = {
  clientConnected: boolean;
  juggleworkServerStatus: JuggleWorkServerStatus;
  developerMode: boolean;
  showConnectionStatus?: boolean;
  onSendFeedback: () => void;
  mcpConnectedCount: number;
  loading?: boolean;
  initializing?: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
  juggleWorkConnectState?: SessionCloudMcpMaintenanceState;
};

export function StatusBar(props: StatusBarProps) {
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const { config: shellConfig } = useShellConfig();
  const docsButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackButtonRef = useRef<HTMLButtonElement>(null);
  const [initializing, setInitializing] = useState(
    () => Date.now() - STATUS_BAR_BOOT_STARTED_AT < STATUS_BAR_INITIALIZING_MS,
  );
  const juggleWorkConnectStatus = resolveJuggleWorkConnectStatus(
    denAuth.isSignedIn
      || (denAuth.status === "checking" && Boolean(readDenSettings().authToken?.trim())),
    props.juggleWorkConnectState,
  );

  useEffect(() => {
    if (!initializing) return;
    const remaining = Math.max(
      0,
      STATUS_BAR_INITIALIZING_MS - (Date.now() - STATUS_BAR_BOOT_STARTED_AT),
    );
    const timeout = window.setTimeout(() => setInitializing(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [initializing]);

  const docsControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "status.docs.open",
    label: "Open JuggleWork docs",
    description: "Open the documentation from the status bar.",
    sideEffect: "external",
    targetRef: docsButtonRef,
    execute: () => platform.openLink(DOCS_URL),
  }), [platform]);
  useControlAction(docsControlAction);

  const feedbackControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "status.feedback.open",
    label: "Send feedback",
    description: "Open the JuggleWork feedback surface from the status bar.",
    sideEffect: "external",
    targetRef: feedbackButtonRef,
    execute: props.onSendFeedback,
  }), [props.onSendFeedback]);
  useControlAction(feedbackControlAction);

  return (
    <div className="border-t border-border bg-background">
      <div className="flex h-8 items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {props.showConnectionStatus !== false ? (
            <StatusIndicator
              clientConnected={props.clientConnected}
              juggleworkServerStatus={props.juggleworkServerStatus}
              developerMode={props.developerMode}
              loading={props.loading}
              initializing={initializing}
              reloadBusy={props.reloadBusy}
              reloadError={props.reloadError}
            />
          ) : null}
          {juggleWorkConnectStatus ? (
            <>
              {props.showConnectionStatus !== false ? <span className="h-3.5 w-px shrink-0 bg-border" /> : null}
              <JuggleWorkConnectIndicator
                status={juggleWorkConnectStatus}
                onRunDiagnostics={() => navigate("/settings/connect")}
              />
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {shellConfig.docsButton ? (
            <Button
              ref={docsButtonRef}
              className="text-muted-foreground gap-2"
              variant="ghost"
              size="xs"
              onClick={() => platform.openLink(DOCS_URL)}
              title={t("status.open_docs")}
              aria-label={t("status.open_docs")}
            >
              <BookOpen className="size-3.5" />
              <span>{t("status.docs")}</span>
            </Button>
          ) : null}
          {shellConfig.feedbackButton ? (
            <Button
              ref={feedbackButtonRef}
              className="text-muted-foreground gap-2"
              variant="ghost"
              size="xs"
              onClick={props.onSendFeedback}
              title={t("status.send_feedback")}
              aria-label={t("status.send_feedback")}
            >
              <MessageCircleMore className="size-3.5" />
              <span>
                {t("status.feedback")}
              </span>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
