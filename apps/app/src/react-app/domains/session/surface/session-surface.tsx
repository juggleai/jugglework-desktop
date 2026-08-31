/** @jsxImportSource react */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { Check, Minimize2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe, isCompactSessionCommand } from "@/app/lib/opencode-session";
import { t } from "@/i18n";
import { readWorkspaceCloudImports, type CloudImportedPlugin } from "@/app/cloud/import-state";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import type {
  JuggleWorkServerClient,
  JuggleWorkSessionSnapshot,
} from "@/app/lib/jugglework-server";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  McpServerEntry,
  McpStatusMap,
  ModelRef,
  PendingPermission,
  PendingQuestion,
  SkillCard,
  SlashCommandOption,
  TodoItem,
} from "@/app/types";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "@/app/lib/app-inspector";
import { useControlAction, type JuggleWorkControlAction } from "@/react-app/shell/control/control-provider";
import { attemptSilentMcpReauth } from "@/react-app/domains/connections/mcp-silent-reauth";
import { applyWorkspaceMcpInventoryPolicy, isComposerManageableMcpEntry, isInternalCloudMcpTransport, selectComposerAvailableMcpEntries, selectEffectiveMcpEntries } from "@/react-app/domains/connections/workspace-mcp-inventory";
import { resolveWorkspaceMcpKey } from "@/react-app/domains/connections/workspace-mcp-key";
import { MCP_QUICK_CONNECT, getMcpServerName } from "@/app/constants";
import { isMcpConnectorEntry } from "@/react-app/domains/settings/pages/project-extensions/connectors-source";
import type {
  CloudMcpSubmissionGateState,
  CloudMcpSubmissionResult,
} from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { ReactSessionComposer } from "./composer/composer";
import { effectiveSessionRunning, isSessionBusyError } from "./session-run-recovery";
import {
  classifyTaskProgress,
  shouldAcknowledgeTerminalProgress,
  shouldShowTaskProgress,
  shouldSynthesizeBusyAfterAcceptance,
} from "./task-progress-state";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./composer/mention-encoding";
import { desktopBridge, openDesktopUrl } from "@/app/lib/desktop";
import { isNewSessionCommand, parseSlashCommandInvocation, withBuiltinSlashCommands } from "./composer/slash-command";
import { DevProfiler } from "@/react-app/shell/dev-profiler";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { useReactRenderWatchdog } from "@/react-app/shell/react-render-watchdog";
import { SessionDebugPanel } from "./debug-panel";
import { deriveContextEstimationMessages, deriveRenderedSessionMessages, resolveRenderedSessionSnapshot } from "./session-render-state";
import { useLocal } from "@/react-app/kernel/local-provider";
import { isAttachmentFileReadable, resolveAttachmentFileMetadata } from "@/react-app/domains/session/sync/attachment-file-part";
import { deriveSessionRenderModel } from "@/react-app/domains/session/sync/transition-controller";
import { useSessionScrollController } from "./scroll-controller";
import { SessionScrollOverlay } from "./scroll-overlay";
import { SessionFindBar } from "./find-bar";
import { useSessionFindStore } from "./find-store";
import { getSessionActivityStatusLabel, useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";
import { PermissionApprovalPanel } from "@/react-app/domains/session/chat/permission-approval-modal";
import { QuestionPanel } from "@/react-app/domains/session/modals/question-modal";
import { QueuedMessagesPanel } from "@/react-app/domains/session/modals/queued-messages-panel";
import { shouldDrainQueuedTask } from "./queued-draft-policy";
import { deriveOpenTargets, selectAutoOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import {
  captureTodoSnapshotRevision,
  clearSessionTodos,
  seedSessionState,
  snapshotKey as reactSnapshotKey,
  statusKey as reactStatusKey,
  transcriptKey as reactTranscriptKey,
} from "@/react-app/domains/session/sync/session-sync";
import { useSessionTodos } from "@/react-app/domains/session/sync/use-session-todos";
import { resolveForkBoundaryId } from "@/react-app/domains/session/sync/transcript-reconcile";
import {
  getComposerAttachments,
  getComposerCapabilities,
  getComposerDraft,
  getComposerHistory,
  getComposerMentions,
  getComposerPasteParts,
  getComposerQueuedDrafts,
  useComposerStateStore,
  type ComposerCapabilityPart,
} from "./composer-state-store";
import { liveActivityLabel } from "@/lib/live-activity";
import {
  COMPOSER_TOKEN_SPLIT_RE,
  composerCapabilityToken,
  fallbackCapabilityPrompt,
  parseComposerCapabilityToken,
  replaceComposerCapabilityTokens,
} from "./composer/capability-tags";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider, type DispatchAction } from "@/components/chat/message-list-provider";
import type {
  ChatToolReconnectAction,
  ChatToolReconnectProgress,
  ChatToolReconnectResult,
} from "@/components/tools/error-attribution";
import { useChatMcpReconnectStore } from "@/components/tools/mcp-reconnect-state";
import {
  isChatMcpReconnectScopeCurrent,
  waitForFreshMcpAuthorization,
  type ChatMcpReconnectScope,
} from "./mcp-chat-reconnect";
import { OpenTargetProvider, type OpenTargetOptions } from "@/lib/target-provider";
import type { ThreadStatus } from "@/lib/messages";
import {
  EnvironmentVariableProvider,
  type ApplyEnvironmentChangesResult,
} from "@/react-app/domains/settings/pages/environment-variable-provider";
import {
  EMPTY_CONNECT_CAPABILITY_INVENTORY,
  listAssignedConnectCapabilities,
  mergeConnectLocalMcpServers,
  type ConnectCapabilityInventory,
} from "./connect-capability-inventory";

const EMPTY_TRANSCRIPT: UIMessage[] = [];
const IDLE_STATUS: SessionStatus = { type: "idle" };
const DEFAULT_COMPOSER_CONTROL_TEXT = "Help me outline the next JuggleWork task.";
const SESSION_SURFACE_SELECTOR = "[data-session-surface-id]";
const MARKDOWN_PRIMITIVE_EVAL_TEXT = `# Markdown proof heading

This shared renderer keeps **bold proof text**, inline \`renderMarkdownHtml\`, and [JuggleWork link](https://juggle.im) readable in one message.

\`\`\`ts
const pipeline = "shared markdown primitive";
console.log(pipeline);
\`\`\`

Search token: markdown-primitive-highlight.`;

type SessionError = {
  message: string;
  kind?: "model-not-found" | "generic";
  /** For model-not-found: the model that failed. */
  failedModel?: { providerID: string; modelID: string };
  /** For model-not-found: suggested replacements from the backend. */
  suggestions?: Array<{ providerID: string; modelID: string }>;
};

function createMarkdownPrimitiveEvalMessages(sessionId: string) {
  const userMessageId = `${sessionId}:eval-markdown-user`;
  const assistantMessageId = `${sessionId}:eval-markdown-assistant`;
  const messages: UIMessage[] = [
    {
      id: userMessageId,
      role: "user",
      parts: [{ type: "text", text: "Show the Markdown primitive proof message." }],
      metadata: { opencode: { created: Date.now() } },
    },
    {
      id: assistantMessageId,
      role: "assistant",
      parts: [{ type: "text", text: MARKDOWN_PRIMITIVE_EVAL_TEXT }],
      metadata: { opencode: { created: Date.now() + 1 } },
    },
  ];

  return { messages, assistantMessageId };
}

export type SessionSurfaceProps = {
  client: JuggleWorkServerClient;
  environmentClient?: JuggleWorkServerClient | null;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  isControlTarget: boolean;
  opencodeBaseUrl: string;
  juggleworkToken: string;
  developerMode: boolean;
  modelLabel: string;
  onModelClick: () => void;
  modelPickerOpen: boolean;
  modelUnavailable?: boolean;
  taskSubmissionDisabled?: boolean;
  selectedModel: ModelRef;
  /** 当前模型声明的上下文窗口上限；0 表示模型目录未提供。 */
  contextWindowTokens: number;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  onSendDraft: (draft: ComposerDraft, sessionId: string) => Promise<CloudMcpSubmissionResult>;
  onCreateNewSession: () => Promise<string | null>;
  cloudMcpSubmissionState: CloudMcpSubmissionGateState;
  onOpenConnect: () => void;
  onDraftChange: (draft: ComposerDraft) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<import("@opencode-ai/sdk/v2/client").Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<import("@/app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  activePermission?: PendingPermission | null;
  permissionReplyBusy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  safeStringify?: (value: unknown) => string;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
  providerConnectedCount?: number;
  onOpenSettingsSection?: ((section: "commands" | "skills" | "mcps" | "plugins" | "providers") => void) | undefined;
  onRevertToMessage?: (messageId: string, sessionId: string) => Promise<boolean>;
  onForkAtMessage?: (messageId: string | null, sessionId: string) => void;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions, sessionId?: string) => void;
  environmentRuntimeKey?: string | null;
  onApplyEnvironmentChanges?: () => Promise<ApplyEnvironmentChangesResult>;
};

function messageToReadableText(message: UIMessage) {
  const header = message.role === "user" ? "You" : message.role === "assistant" ? "JuggleWork" : message.role;
  const body = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "file") {
        const name = part.filename?.trim() || "file";
        const url = part.url.startsWith("data:")
          ? `data:${part.mediaType || "application/octet-stream"};base64,…`
          : part.url;
        return [`[file:${name}] ${url}`];
      }
      if (part.type === "dynamic-tool") {
        if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n");
  return `${header}\n${body}`.trim();
}

function transcriptToText(messages: UIMessage[]) {
  return messages
    .flatMap((message) => {
      const text = messageToReadableText(message);
      return text ? [text] : [];
    })
    .join("\n\n---\n\n");
}

function isSessionSurfaceMounted(sessionId: string) {
  for (const surface of document.querySelectorAll(SESSION_SURFACE_SELECTOR)) {
    if (surface.getAttribute("data-session-surface-id") === sessionId) return true;
  }
  return false;
}

function firstMountedSessionSurfaceId() {
  return document.querySelector(SESSION_SURFACE_SELECTOR)?.getAttribute("data-session-surface-id") ?? null;
}

function resolveFindOwnerSessionId() {
  const focusedRoot = document.activeElement?.closest(SESSION_SURFACE_SELECTOR);
  const focusedSessionId = focusedRoot?.getAttribute("data-session-surface-id") ?? null;
  if (focusedSessionId) return focusedSessionId;

  const lastFocusedSessionId = useSessionFindStore.getState().lastFocusedSessionId;
  if (lastFocusedSessionId && isSessionSurfaceMounted(lastFocusedSessionId)) {
    return lastFocusedSessionId;
  }

  return firstMountedSessionSurfaceId();
}

function statusLabel(snapshot: JuggleWorkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function controlTextArgument(args: unknown) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && "text" in args) {
    const text = (args as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return DEFAULT_COMPOSER_CONTROL_TEXT;
}

const waitForControl = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function useSharedQueryState<T>(queryKey: readonly unknown[], fallback: T) {
  const query = useQuery<T, Error, T, readonly unknown[]>({
    queryKey,
    queryFn: async () => fallback,
    enabled: false,
  });
  return query.data ?? fallback;
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

/** 与消息列表底部的实时提示保持同一形态：流光文字，无图标。 */
function AssistantWaitingCard({ label = liveActivityLabel("responding") }: { label?: string }) {
  return (
    <div className="-mt-1 flex justify-start" role="status" aria-live="polite">
      <div className="inline-flex items-center py-0 text-[12px]">
        <span className="live-activity-text font-medium tracking-[-0.01em]">{`${label}...`}</span>
      </div>
    </div>
  );
}

function TodoPanel(props: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const todos = props.todos.filter((todo) => todo.content.trim());
  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  const progressLabel = t("session.todo_progress_label");
  const label = expanded ? progressLabel : `${progressLabel} · ${completedTodos}/${todos.length}`;

  if (todos.length === 0) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
          onClick={() => setExpanded((current) => !current)}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-11">{label}</span>
          </div>
          <Minimize2 size={12} className={`text-gray-8 transition-transform ${expanded ? "" : "rotate-180"}`} />
        </button>
        {expanded ? (
          <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pb-3">
            {todos.map((todo, index) => {
              const done = todo.status === "completed";
              const cancelled = todo.status === "cancelled";
              const active = todo.status === "in_progress";
              return (
                <div key={todo.id} className="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <div
                      className={`flex size-4.5 items-center justify-center rounded-full border ${
                        done
                          ? "border-green-6 bg-green-2 text-green-11"
                          : active
                            ? "border-amber-6 bg-amber-2 text-amber-11"
                            : cancelled
                              ? "border-gray-6 bg-gray-2 text-gray-8"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                      }`}
                    >
                      {done ? <Check size={10} /> : active ? <span className="size-1.5 rounded-full bg-amber-9" /> : null}
                    </div>
                  </div>
                  <div className={`flex-1 text-sm leading-relaxed ${cancelled ? "text-gray-9 line-through" : "text-gray-12"}`}>
                    <span className="mr-1.5 text-gray-9">{index + 1}.</span>
                    {todo.content}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
    </div>
  );
}

function parseSessionError(thrown: unknown): SessionError {
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  // Try to detect ProviderModelNotFoundError from the SDK error shape.
  // The error message may be a JSON string from our serializer in session-route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.name === "ProviderModelNotFoundError" && parsed?.data) {
      const { providerID, modelID, suggestions } = parsed.data;
      return {
        message: `Model ${providerID}/${modelID} is not available.`,
        kind: "model-not-found",
        failedModel: { providerID, modelID },
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain message
  }
  // Check if the raw string mentions model-not-found patterns
  if (/ProviderModelNotFoundError/i.test(raw) || /model.*not found/i.test(raw)) {
    return { message: raw, kind: "model-not-found" };
  }
  return { message: raw || "Failed to send prompt." };
}

function SessionErrorCard({ error, onDismiss, onChangeModel, onOpenModelPicker }: {
  error: SessionError;
  onDismiss: () => void;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onOpenModelPicker?: () => void;
}) {
  return (
    <div className="mx-auto max-w-[720px] px-3 py-3 sm:px-5">
      <div className="rounded-2xl border border-red-6/30 bg-red-3/15 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-red-11">{error.message}</div>
            {error.kind === "model-not-found" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {error.suggestions && error.suggestions.length > 0 ? (
                  error.suggestions.map((s) => (
                    <button
                      key={`${s.providerID}/${s.modelID}`}
                      type="button"
                      className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                      onClick={() => {
                        onChangeModel?.(s);
                        onDismiss();
                      }}
                    >
                      Use {s.providerID}/{s.modelID}
                    </button>
                  ))
                ) : null}
                <button
                  type="button"
                  className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    onOpenModelPicker?.();
                    onDismiss();
                  }}
                >
                  Change model
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-red-10 transition-colors hover:bg-red-3 hover:text-red-11"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

function sameAttachments(left: ComposerAttachment[], right: ComposerAttachment[]): boolean {
  return left.length === right.length && left.every((attachment, index) => attachment.id === right[index]?.id);
}

export function SessionSurface(props: SessionSurfaceProps) {
  const local = useLocal();
  const todos = useSessionTodos(props.workspaceId, props.sessionId);
  const taskProgressKind = classifyTaskProgress(todos);
  const [terminalProgressAcknowledgement, setTerminalProgressAcknowledgement] = useState(false);
  const taskProgressWasActiveRef = useRef(false);
  const taskProgressPreviousKindRef = useRef(taskProgressKind);
  const taskProgressRunEndedAtRef = useRef(0);
  const { config: shellConfig } = useShellConfig();
  const showThinking = local.prefs.showThinking;
  const findOpen = useSessionFindStore((state) => state.open);
  const findSessionId = useSessionFindStore((state) => state.sessionId);
  const findAppliedQuery = useSessionFindStore((state) => state.appliedQuery);
  const setFindLastFocused = useSessionFindStore((state) => state.setLastFocused);
  const findOwned = findOpen && findSessionId === props.sessionId;
  const findHighlightQuery = findOwned && findAppliedQuery.trim().length >= 2 ? findAppliedQuery : "";
  const sessionActivityStatus = useSessionActivityStore(
    (state) => state.statusesByWorkspaceId[props.workspaceId]?.[props.sessionId] ?? "idle",
  );
  const sessionActivityRunActive = useSessionActivityStore(
    (state) => state.recordsByWorkspaceId[props.workspaceId]?.[props.sessionId]?.runActive ?? false,
  );
  const draft = useComposerStateStore((state) => getComposerDraft(state, props.sessionId));
  const attachments = useComposerStateStore((state) => getComposerAttachments(state, props.sessionId));
  const mentions = useComposerStateStore((state) => getComposerMentions(state, props.sessionId));
  const pasteParts = useComposerStateStore((state) => getComposerPasteParts(state, props.sessionId));
  const capabilities = useComposerStateStore((state) => getComposerCapabilities(state, props.sessionId));
  const setComposerDraft = useComposerStateStore((state) => state.setDraft);
  const setComposerAttachments = useComposerStateStore((state) => state.setAttachments);
  const setComposerMentions = useComposerStateStore((state) => state.setMentions);
  const setComposerPasteParts = useComposerStateStore((state) => state.setPasteParts);
  const setComposerCapabilities = useComposerStateStore((state) => state.setCapabilities);
  const clearComposerSession = useComposerStateStore((state) => state.clearSession);
  const inputHistory = useComposerStateStore((state) => getComposerHistory(state, props.sessionId));
  const appendComposerHistory = useComposerStateStore((state) => state.appendHistory);
  // Queued follow-up drafts live in the shared composer store keyed by session
  // id. That keeps a queued message in session A from being drained into
  // session B when the route swaps the same surface component to another
  // session.
  const queuedDrafts = useComposerStateStore((state) => getComposerQueuedDrafts(state, props.sessionId));
  const appendQueuedDraft = useComposerStateStore((state) => state.appendQueuedDraft);
  const removeQueuedDraftFromStore = useComposerStateStore((state) => state.removeQueuedDraft);
  const restoreQueuedDraft = useComposerStateStore((state) => state.restoreQueuedDraft);
  const editQueuedDraftInStore = useComposerStateStore((state) => state.editQueuedDraft);
  const clearQueuedDrafts = useComposerStateStore((state) => state.clearQueuedDrafts);
  const [error, setError] = useState<SessionError | null>(null);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: JuggleWorkSessionSnapshot } | null>(null);
  const [toolSkills, setToolSkills] = useState<SkillCard[]>([]);
  const [toolMcpServers, setToolMcpServers] = useState<McpServerEntry[]>([]);
  const [toolMcpStatus, setToolMcpStatus] = useState<string | null>(null);
  const [toolMcpStatuses, setToolMcpStatuses] = useState<McpStatusMap>({});
  const [toolImportedPlugins, setToolImportedPlugins] = useState<CloudImportedPlugin[]>([]);
  const [steering, setSteering] = useState(false);
  const connectInventoryCacheRef = useRef<{
    scope: string;
    promise: Promise<ConnectCapabilityInventory>;
  } | null>(null);
  const [verifiedOpenTargets, setVerifiedOpenTargets] = useState<OpenTarget[]>([]);
  const [cloudQueueRetryVersion, setCloudQueueRetryVersion] = useState(0);
  const [queueDrainVersion, setQueueDrainVersion] = useState(0);
  const sending = props.cloudMcpSubmissionState.status === "sending";
  const cloudQueueBlockedRef = useRef(false);
  const drainingQueueRef = useRef(false);
  const queueWaitsForIdleRef = useRef(false);
  const queuedRunObservedBusyRef = useRef(false);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const autoOpenedTargetRef = useRef<string | null>(null);
  const initializedAutoOpenSessionRef = useRef<string | null>(null);
  const activeSurfaceIdentityRef = useRef(`${props.workspaceId}:${props.sessionId}`);
  const inFlightSendIdentitiesRef = useRef(new Set<string>());
  activeSurfaceIdentityRef.current = `${props.workspaceId}:${props.sessionId}`;
  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.juggleworkToken, mode: "jugglework" }),
    [props.opencodeBaseUrl, props.juggleworkToken],
  );

  const snapshotQueryKey = useMemo(
    () => reactSnapshotKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const transcriptQueryKey = useMemo(
    () => reactTranscriptKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const statusQueryKey = useMemo(
    () => reactStatusKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const activeRunsQuery = useQuery({
    queryKey: ["session-active-runs", props.workspaceId],
    queryFn: () => props.client.listActiveSessionRuns(props.workspaceId),
    staleTime: 250,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.items.length ? 750 : false,
  });
  const snapshotTodoRevisionBySnapshotRef = useRef(new WeakMap<JuggleWorkSessionSnapshot, number>());
  const snapshotQuery = useQuery<JuggleWorkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async () => {
      const todoRevision = captureTodoSnapshotRevision();
      const snapshot = (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item;
      snapshotTodoRevisionBySnapshotRef.current.set(snapshot, todoRevision);
      return snapshot;
    },
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const currentSnapshotTodoRevision = currentSnapshot
    ? snapshotTodoRevisionBySnapshotRef.current.get(currentSnapshot)
    : undefined;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, EMPTY_TRANSCRIPT);
  const statusState = useSharedQueryState(statusQueryKey, currentSnapshot?.status ?? IDLE_STATUS);

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setSteering(false);
    setError(null);
    setShowDelayedLoading(false);
    setAwaitingAssistantBaseline(null);
    setTerminalProgressAcknowledgement(false);
    taskProgressWasActiveRef.current = false;
    taskProgressPreviousKindRef.current = "empty";
    taskProgressRunEndedAtRef.current = 0;
    // Composer draft state lives in the shared store keyed by session id, so
    // switching sessions preserves each session's own in-progress composer.
    autoOpenedTargetRef.current = null;
    initializedAutoOpenSessionRef.current = null;
    setVerifiedOpenTargets([]);
  }, [props.sessionId, props.workspaceId]);

  // Publish a composer inspector slice so external drivers can read draft
  // state, attachments, mentions, and sending status from the running app.
  useEffect(() => {
    const dispose = publishInspectorSlice("composer", () => ({
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      draft,
      draftLength: draft.length,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      })),
      mentions,
      pasteParts: pasteParts.map((part) => ({
        id: part.id,
        label: part.label,
        lines: part.lines,
      })),
      sending,
      cloudMcpSubmission: {
        status: props.cloudMcpSubmissionState.status,
        attempt: props.cloudMcpSubmissionState.attempt,
        maxAttempts: props.cloudMcpSubmissionState.maxAttempts,
        code: props.cloudMcpSubmissionState.issue?.code ?? null,
        stage: props.cloudMcpSubmissionState.issue?.stage ?? null,
      },
      error,
    }));
    return dispose;
  }, [
    attachments,
    draft,
    error,
    mentions,
    pasteParts,
    props.sessionId,
    props.workspaceId,
    props.cloudMcpSubmissionState,
    sending,
  ]);

  useEffect(() => {
    recordInspectorEvent("session.mounted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
    });
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    seedSessionState(props.workspaceId, currentSnapshot, {
      snapshotTodoRevision: currentSnapshotTodoRevision,
      skipTodos: currentSnapshotTodoRevision === undefined,
    });
  }, [currentSnapshot, currentSnapshotTodoRevision, props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    seedSessionState(props.workspaceId, currentSnapshot, {
      snapshotTodoRevision: currentSnapshotTodoRevision,
      skipTodos: currentSnapshotTodoRevision === undefined,
    });
  }, [props.sessionId, currentSnapshot, currentSnapshotTodoRevision, props.workspaceId]);

  const snapshot = resolveRenderedSessionSnapshot({
    sessionId: props.sessionId,
    currentSnapshot,
    cachedRendered: rendered,
  });
  const liveStatus = statusState ?? snapshot?.status ?? IDLE_STATUS;
  const coordinatorRun = activeRunsQuery.data?.items.find((run) => run.sessionId === props.sessionId) ?? null;
  const preparingCloudTools = props.cloudMcpSubmissionState.status === "checking" ||
    props.cloudMcpSubmissionState.status === "repairing";
  const chatStreaming = effectiveSessionRunning({
    sending,
    liveStatus: liveStatus.type,
    activityRunActive: sessionActivityRunActive,
    coordinatorActive: coordinatorRun !== null,
  });
  const showTaskProgress = shouldShowTaskProgress({
    kind: taskProgressKind,
    runActive: chatStreaming,
    terminalAcknowledgement: terminalProgressAcknowledgement,
  });

  useEffect(() => {
    const wasActive = taskProgressWasActiveRef.current;
    const previousKind = taskProgressPreviousKindRef.current;
    taskProgressWasActiveRef.current = chatStreaming;
    taskProgressPreviousKindRef.current = taskProgressKind;
    if (wasActive && !chatStreaming) taskProgressRunEndedAtRef.current = Date.now();
    if (chatStreaming || taskProgressKind !== "terminal") {
      setTerminalProgressAcknowledgement(false);
      return;
    }
    const acknowledge = shouldAcknowledgeTerminalProgress({
      runJustEnded: wasActive && !chatStreaming,
      terminalJustArrivedAfterRunEnd:
        previousKind !== "terminal" &&
        Date.now() - taskProgressRunEndedAtRef.current <= 2_000,
      kind: taskProgressKind,
    });
    if (!acknowledge) return;
    setTerminalProgressAcknowledgement(true);
    const timer = window.setTimeout(() => setTerminalProgressAcknowledgement(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [chatStreaming, taskProgressKind]);

  useEffect(() => {
    void activeRunsQuery.refetch();
  }, [activeRunsQuery.refetch, liveStatus.type, props.sessionId]);

  useEffect(() => {
    if (!activeRunsQuery.isSuccess || coordinatorRun || liveStatus.type !== "idle" || !sessionActivityRunActive) return;
    useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, { type: "idle" });
  }, [activeRunsQuery.isSuccess, coordinatorRun, liveStatus.type, props.sessionId, props.workspaceId, sessionActivityRunActive]);

  useEffect(() => {
    if (!chatStreaming) setSteering(false);
  }, [chatStreaming]);
  const status = useMemo((): ThreadStatus => {
    if (sending) {
      return "submitted";
    }

    if (liveStatus.type === "busy") {
      return "streaming";
    }

    if (liveStatus.type === "retry") {
      return "retrying";
    }

    return "ready";
  }, [liveStatus, sending]);
  const [evalMarkdownMessages, setEvalMarkdownMessages] = useState<UIMessage[]>(EMPTY_TRANSCRIPT);
  useEffect(() => {
    setEvalMarkdownMessages(EMPTY_TRANSCRIPT);
  }, [props.sessionId]);

  const baseRenderedMessages = useMemo(
    () => deriveRenderedSessionMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const contextEstimationMessages = useMemo(
    () => deriveContextEstimationMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const renderedMessages = useMemo(() => {
    if (evalMarkdownMessages.length === 0) return baseRenderedMessages;

    return [...baseRenderedMessages, ...evalMarkdownMessages];
  }, [baseRenderedMessages, evalMarkdownMessages]);
  const seedMarkdownPrimitiveControlAction = useMemo<JuggleWorkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_chat",
      label: "Seed markdown primitive chat proof",
      description: "Dev-only eval hook that renders deterministic Markdown in the active conversation.",
      sideEffect: "mutation",
      disabled: !props.sessionId,
      execute: () => {
        const seeded = createMarkdownPrimitiveEvalMessages(props.sessionId);
        setEvalMarkdownMessages(seeded.messages);
        return {
          ok: true,
          assistantMessageId: seeded.assistantMessageId,
          messageCount: seeded.messages.length,
        };
      },
    };
  }, [props.sessionId]);
  useControlAction(props.isControlTarget ? seedMarkdownPrimitiveControlAction : null);
  const openTargets = useMemo(() => deriveOpenTargets(renderedMessages), [renderedMessages]);
  const openTargetsFingerprint = useMemo(
    () => openTargets.map((target) => `${target.kind}:${target.value}:${target.confidence}`).join("|"),
    [openTargets],
  );
  const autoOpenTarget = selectAutoOpenTarget(verifiedOpenTargets);
  const pendingSessionLoad = !snapshot && snapshotQuery.isLoading && renderedMessages.length === 0;
  const assistantOutputAfterAwaitStart = useMemo(() => {
    if (awaitingAssistantBaseline === null) return false;
    return renderedMessages
      .slice(awaitingAssistantBaseline)
      .some(messageHasVisibleAssistantOutput);
  }, [awaitingAssistantBaseline, renderedMessages]);
  const showAssistantWaitState = awaitingAssistantBaseline !== null && !assistantOutputAfterAwaitStart;
  const showAssistantRespondingState = awaitingAssistantBaseline !== null && assistantOutputAfterAwaitStart && chatStreaming;
  const effectiveActivityStatus: SessionActivityStatus = sessionActivityStatus !== "idle"
    ? sessionActivityStatus
    : showAssistantWaitState
      ? "thinking"
      : showAssistantRespondingState
        ? "responding"
        : "idle";
  useReactRenderWatchdog("SessionSurface", {
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    messageCount: renderedMessages.length,
    liveStatus: liveStatus.type,
    sending,
    pendingSessionLoad,
    showAssistantWaitState,
    showAssistantRespondingState,
    hasSnapshot: Boolean(snapshot),
  });

  useEffect(() => {
    if (!autoOpenTarget || chatStreaming) return;
    if (autoOpenedTargetRef.current === autoOpenTarget.id) return;
    autoOpenedTargetRef.current = autoOpenTarget.id;
    props.onOpenTarget?.(autoOpenTarget, { auto: true }, props.sessionId);
  }, [autoOpenTarget, chatStreaming, props.onOpenTarget, props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    function initializeAutoOpenState(targets: OpenTarget[]) {
      if (initializedAutoOpenSessionRef.current === props.sessionId) return;
      initializedAutoOpenSessionRef.current = props.sessionId;
      autoOpenedTargetRef.current = selectAutoOpenTarget(targets)?.id ?? null;
    }

    async function verifyTargets() {
      if (!openTargets.length) {
        initializeAutoOpenState([]);
        setVerifiedOpenTargets([]);
        return;
      }
      try {
        const response = await props.client.resolveArtifacts(props.workspaceId, openTargets);
        if (!cancelled) {
          const nextTargets = response.items as OpenTarget[];
          initializeAutoOpenState(nextTargets);
          setVerifiedOpenTargets(nextTargets);
        }
      } catch {
        if (!cancelled) {
          const nextTargets = openTargets.map((target) => ({ ...target, exists: target.kind === "url" }));
          initializeAutoOpenState(nextTargets);
          setVerifiedOpenTargets(nextTargets);
        }
      }
    }
    void verifyTargets();
    return () => { cancelled = true; };
  }, [chatStreaming, openTargetsFingerprint, props.client, props.sessionId, props.workspaceId]);

  useEffect(() => {
    usePanelTabStore.getState().syncTranscriptArtifacts(props.sessionId, verifiedOpenTargets);
  }, [props.sessionId, verifiedOpenTargets]);

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  useEffect(() => {
    if (awaitingAssistantBaseline === null) return;
    if (assistantOutputAfterAwaitStart) {
      return;
    }
    if (sending || liveStatus.type !== "idle" || renderedMessages.length <= awaitingAssistantBaseline) return;
    const id = window.setTimeout(() => {
      setAwaitingAssistantBaseline(null);
    }, 1200);
    return () => window.clearTimeout(id);
  }, [assistantOutputAfterAwaitStart, awaitingAssistantBaseline, liveStatus.type, renderedMessages.length, sending]);

  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshot ? props.sessionId : null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = useCallback((text: string, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const capabilityByToken = new Map(
      capabilities.map((item) => [composerCapabilityToken(item.kind, item.name), item]),
    );
    const parts: ComposerPart[] = text.split(COMPOSER_TOKEN_SPLIT_RE).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch) {
        // Attachment chips are visual tokens only; bytes travel via draft.attachments.
        return [] as ComposerDraft["parts"];
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch) {
        const target = pasteParts.find((item) => item.label === pasteMatch[1]);
        if (target) {
          return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines }];
        }
      }
      const capability = parseComposerCapabilityToken(segment);
      if (capability) {
        // 本地技能沿用原有的 skill part；云端技能/扩展/MCP 走 capability part，
        // 并带上登记的完整文案，队列草稿回填时才不会丢失。
        if (capability.kind === "skill") {
          return [{ type: "skill", name: capability.name } satisfies ComposerDraft["parts"][number]];
        }
        return [{
          type: "capability",
          kind: capability.kind,
          name: capability.name,
          prompt: capabilityByToken.get(segment)?.prompt
            ?? fallbackCapabilityPrompt(capability.kind, capability.name),
        } satisfies ComposerDraft["parts"][number]];
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    // Expand paste placeholders in resolvedText so the model receives
    // the actual pasted content instead of "[pasted text <label>]".
    let resolved = text;
    for (const part of pasteParts) {
      resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
    }
    resolved = resolved.replace(/\[attachment [^\]]+\]/g, "");
    // 能力标签在这里展开成模型真正看到的文本：本地技能是一句自然语言，
    // 云端技能/扩展/MCP 用插入时登记的完整指令（登记丢失时退回通用表述）。
    resolved = replaceComposerCapabilityTokens(resolved, (kind, name) => (
      capabilityByToken.get(composerCapabilityToken(kind, name))?.prompt
        ?? fallbackCapabilityPrompt(kind, name)
    ));
    for (const value of Object.keys(mentions)) {
      resolved = resolved.replaceAll(`@${encodeComposerMentionValue(value)}`, `@${value}`);
    }
    const slashCommand = parseSlashCommandInvocation(resolved);
    return {
      mode: "prompt",
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: resolved,
      command: slashCommand ?? undefined,
    };
  }, [capabilities, mentions, pasteParts]);

  const handleComposerDraftChange = useCallback((value: string) => {
    setComposerDraft(props.sessionId, value);
    const idsInDraft = new Set(
      [...value.matchAll(/\[attachment ([^\]]+)\]/g)].map((match) => match[1]).filter((id): id is string => Boolean(id)),
    );
    const retained = attachments.filter((attachment) => idsInDraft.has(attachment.id));
    if (retained.length === attachments.length) return;
    for (const attachment of attachments) {
      if (!idsInDraft.has(attachment.id)) revokeAttachmentPreview(attachment);
    }
    setComposerAttachments(props.sessionId, retained);
  }, [attachments, props.sessionId, setComposerAttachments, setComposerDraft]);

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : "Failed to copy transcript." });
    }
  };

  // Core sender shared by initial send and steered follow-ups. OpenCode
  // accepts follow-up user turns mid-run (steering) — the running loop picks
  // up the new message — so this is safe to call while the agent is busy.
  const sendDraft = useCallback(async (nextDraft: ComposerDraft) => {
    const workspaceId = props.workspaceId;
    const sessionId = props.sessionId;
    const surfaceIdentity = `${workspaceId}:${sessionId}`;
    const isCurrentSurface = () => activeSurfaceIdentityRef.current === surfaceIdentity;
    if (props.taskSubmissionDisabled) {
      return { outcome: "cancelled", reason: "context_changed" } as const;
    }
    // 同一会话的 prompt acceptance 返回前只允许一次提交；不同会话仍可独立发送。
    if (inFlightSendIdentitiesRef.current.has(surfaceIdentity)) {
      return { outcome: "cancelled", reason: "context_changed" } as const;
    }
    inFlightSendIdentitiesRef.current.add(surfaceIdentity);
    const runGenerationBeforeSend = useSessionActivityStore.getState()
      .recordsByWorkspaceId[workspaceId]?.[sessionId]?.runGeneration ?? 0;
    if (isCurrentSurface()) setError(null);
    // Progress belongs to the task that produced it. Hide stale progress as
    // soon as the next task is submitted (including a drained queued task);
    // fresh todo.updated events will populate the panel for the new run.
    clearSessionTodos(workspaceId, sessionId);
    try {
      const result = await props.onSendDraft(nextDraft, sessionId);
      if (result.outcome === "blocked" || result.outcome === "cancelled") return result;
      // Only report a run after the pre-send gate released the exact queued
      // submission and the route accepted or sent it.
      appendComposerHistory(sessionId, nextDraft.text);
      const activityStore = useSessionActivityStore.getState();
      const activityAfterSend = activityStore.recordsByWorkspaceId[workspaceId]?.[sessionId];
      const synthesizeBusy = shouldSynthesizeBusyAfterAcceptance({
        runGenerationBeforeSend,
        activityAfterSend,
      });
      if (synthesizeBusy) {
        activityStore.setRunStatus(workspaceId, sessionId, { type: "busy" });
      }
      void activeRunsQuery.refetch();
      if (isCurrentSurface() && (synthesizeBusy || activityAfterSend?.runActive)) {
        setAwaitingAssistantBaseline(renderedMessages.length);
      }
      return result;
    } catch (nextError) {
      if (isSessionBusyError(nextError)) {
        const refreshed = await activeRunsQuery.refetch();
        const active = refreshed.data?.items.some((run) => run.sessionId === sessionId) ?? false;
        if (active) {
          useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });
          if (isCurrentSurface()) {
            setError(null);
            setAwaitingAssistantBaseline(null);
            toast.info("This session is already running. You can stop it or queue this message.");
          }
          return { outcome: "cancelled", reason: "context_changed" } as const;
        }
      }
      const parsed = parseSessionError(nextError);
      captureAnalyticsEvent("task_send_failed", {});
      // TIPS: SessionSurface is reused when switching tabs. A late rejection
      // belongs to the captured session and must never repaint the new tab.
      if (isCurrentSurface()) {
        setError(parsed);
        setAwaitingAssistantBaseline(null);
      }
      useSessionActivityStore.getState().setError(workspaceId, sessionId, parsed.message);
      throw nextError;
    } finally {
      inFlightSendIdentitiesRef.current.delete(surfaceIdentity);
    }
  }, [activeRunsQuery.refetch, appendComposerHistory, props.onSendDraft, props.sessionId, props.taskSubmissionDisabled, props.workspaceId, renderedMessages.length]);

  const clearComposer = useCallback(() => {
    clearComposerSession(props.sessionId);
    props.onDraftChange(buildDraft("", []));
  }, [buildDraft, clearComposerSession, props.onDraftChange, props.sessionId]);

  // Initial send (agent idle) and explicit "Steer" follow-up (agent busy)
  // share the same immediate path.
  const handleSend = useCallback(async () => {
    if (props.taskSubmissionDisabled) return;
    const surfaceIdentity = `${props.workspaceId}:${props.sessionId}`;
    const originalDraft = draft;
    const text = originalDraft.trim();
    if (!text && attachments.length === 0) return;
    const nextDraft = buildDraft(text, attachments);
    const sentAttachments = attachments;
    try {
      if (isNewSessionCommand(nextDraft.command)) {
        const sessionId = await props.onCreateNewSession();
        if (!sessionId) return;
        const currentState = useComposerStateStore.getState();
        const currentDraft = getComposerDraft(currentState, props.sessionId);
        const currentAttachments = getComposerAttachments(currentState, props.sessionId);
        if (currentDraft === originalDraft && sameAttachments(currentAttachments, sentAttachments)) {
          clearComposer();
          sentAttachments.forEach(revokeAttachmentPreview);
        }
        return;
      }

      const compactCommand = isCompactSessionCommand(nextDraft.command);
      const pendingSend = sendDraft(nextDraft);
      // `/compact` is an action rather than conversational input. Clear it as
      // soon as the compaction run starts so the composer does not keep showing
      // a command that is already executing during the potentially long request.
      if (compactCommand) {
        const currentState = useComposerStateStore.getState();
        const currentDraft = getComposerDraft(currentState, props.sessionId);
        const currentAttachments = getComposerAttachments(currentState, props.sessionId);
        if (currentDraft === originalDraft && sameAttachments(currentAttachments, sentAttachments)) {
          clearComposer();
        }
      }
      const result = await pendingSend;
      if (result.outcome === "blocked" || result.outcome === "cancelled") return;
      const currentState = useComposerStateStore.getState();
      const currentDraft = getComposerDraft(currentState, props.sessionId);
      const currentAttachments = getComposerAttachments(currentState, props.sessionId);
      if (currentDraft === originalDraft && sameAttachments(currentAttachments, sentAttachments)) {
        clearComposer();
        sentAttachments.forEach(revokeAttachmentPreview);
      } else {
        const retainedIds = new Set(currentAttachments.map((attachment) => attachment.id));
        sentAttachments
          .filter((attachment) => !retainedIds.has(attachment.id))
          .forEach(revokeAttachmentPreview);
      }
    } catch (nextError) {
      if (activeSurfaceIdentityRef.current === surfaceIdentity) {
        setError(parseSessionError(nextError));
      }
    }
  }, [attachments, buildDraft, clearComposer, draft, props.onCreateNewSession, props.sessionId, props.taskSubmissionDisabled, props.workspaceId, sendDraft]);

  const handleSteer = useCallback(async () => {
    setSteering(true);
    await handleSend();
  }, [handleSend]);

  const handleRetryCloudSubmission = useCallback(() => {
    if (draft.trim() || attachments.length > 0) {
      void handleSend();
      return;
    }
    cloudQueueBlockedRef.current = false;
    setCloudQueueRetryVersion((version) => version + 1);
  }, [attachments.length, draft, handleSend]);

  // Queue: hold the draft locally and clear the composer. The drain effect
  // sends it once the session reports idle.
  const handleQueue = useCallback(() => {
    if (props.taskSubmissionDisabled) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    appendQueuedDraft(props.sessionId, buildDraft(text, attachments));
    queueWaitsForIdleRef.current = true;
    clearComposer();
  }, [appendQueuedDraft, attachments, buildDraft, clearComposer, draft, props.sessionId, props.taskSubmissionDisabled]);

  const removeQueuedDraft = useCallback((id: string) => {
    const removed = removeQueuedDraftFromStore(props.sessionId, id);
    removed?.draft.attachments.forEach(revokeAttachmentPreview);
  }, [props.sessionId, removeQueuedDraftFromStore]);

  const editQueuedDraft = useCallback((id: string) => {
    if (draft.trim() || attachments.length > 0) {
      toast.warning(t("composer.queued_edit_requires_empty"));
      return;
    }
    const edited = editQueuedDraftInStore(props.sessionId, id);
    if (!edited) return;
    window.setTimeout(() => {
      composerShellRef.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
    }, 0);
  }, [attachments.length, draft, editQueuedDraftInStore, props.sessionId]);

  const handleAbort = useCallback(async () => {
    if (!chatStreaming) return;
    setError(null);
    useSessionActivityStore.getState().markFinishReason(props.workspaceId, props.sessionId, "user_cancelled");
    // Stop means stop: drop queued follow-ups before aborting, otherwise the
    // queue-drain effect below re-prompts the agent the moment the abort
    // lands and the session reports idle (#2014).
    queuedDrafts.forEach((item) => item.draft.attachments.forEach(revokeAttachmentPreview));
    clearQueuedDrafts(props.sessionId);
    // The prompt was sent through a directory-scoped client (session-route
    // passes the workspace root), so the abort must target the same scope —
    // without it the server resolves the default project, finds no live run,
    // and answers `200: false` while the stream keeps going (#2014).
    const aborted = await abortSessionSafe(
      opencodeClient,
      props.sessionId,
      props.workspaceRoot.trim() || undefined,
    );
    if (!aborted) {
      setError({ message: t("session.stop_failed") });
      return;
    }
    void activeRunsQuery.refetch();
    captureAnalyticsEvent("task_run_stopped", {});
    await snapshotQuery.refetch();
  }, [activeRunsQuery.refetch, chatStreaming, clearQueuedDrafts, opencodeClient, props.sessionId, props.workspaceId, props.workspaceRoot, queuedDrafts, snapshotQuery.refetch]);

  const handleDismissError = useCallback(() => {
    setError(null);
    useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId);
  }, [props.sessionId, props.workspaceId]);

  // A queued task starts only after the previous run has been observed busy
  // and then reaches idle. Each idle transition claims exactly one FIFO item.
  useEffect(() => {
    if (chatStreaming) {
      if (drainingQueueRef.current) queuedRunObservedBusyRef.current = true;
      queueWaitsForIdleRef.current = queuedDrafts.length > 0;
      return;
    }
    if (!shouldDrainQueuedTask({
      queuedCount: queuedDrafts.length,
      chatStreaming,
      liveStatus: liveStatus.type,
      waitingForIdle: queueWaitsForIdleRef.current,
      draining: drainingQueueRef.current,
      blocked: cloudQueueBlockedRef.current,
    })) return;
    if (props.taskSubmissionDisabled) return;
    const target = queuedDrafts[0];
    if (!target) return;
    drainingQueueRef.current = true;
    queueWaitsForIdleRef.current = false;
    queuedRunObservedBusyRef.current = false;
    const claimed = removeQueuedDraftFromStore(props.sessionId, target.id);
    if (!claimed) {
      drainingQueueRef.current = false;
      return;
    }
    void (async () => {
      try {
        const result = await sendDraft(claimed.draft);
        if (result.outcome === "blocked") {
          cloudQueueBlockedRef.current = true;
          restoreQueuedDraft(props.sessionId, claimed);
        } else if (result.outcome === "cancelled") {
          restoreQueuedDraft(props.sessionId, claimed);
        } else {
          claimed.draft.attachments.forEach(revokeAttachmentPreview);
        }
      } catch {
        restoreQueuedDraft(props.sessionId, claimed);
      } finally {
        drainingQueueRef.current = false;
        // If a run was observed, wait for its next idle transition. If status
        // propagation has not arrived yet, the busy branch above will arm it.
        queueWaitsForIdleRef.current = queuedRunObservedBusyRef.current;
        setQueueDrainVersion((version) => version + 1);
      }
    })();
  }, [chatStreaming, cloudQueueRetryVersion, liveStatus.type, props.sessionId, props.taskSubmissionDisabled, queueDrainVersion, queuedDrafts, removeQueuedDraftFromStore, restoreQueuedDraft, sendDraft]);

  useEffect(() => {
    if (props.cloudMcpSubmissionState.status !== "failed") {
      cloudQueueBlockedRef.current = false;
    }
  }, [props.cloudMcpSubmissionState.status]);

  useEffect(() => {
    props.onDraftChange(buildDraft(draft, attachments));
  }, [attachments, buildDraft, draft, props.onDraftChange]);

  const handleAttachFiles = (files: File[]) => {
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    const oversized = files.filter((file) => file.size > 25 * 1024 * 1024);
    const sized = files.filter((file) => file.size <= 25 * 1024 * 1024);
    if (oversized.length) {
      toast.warning(
        oversized.length === 1 ? `${oversized[0]?.name ?? "File"} is too large` : `${oversized.length} files are too large`,
        { description: "Files over 25 MB were skipped." },
      );
    }
    const unreadable = sized.filter((file) => !isAttachmentFileReadable(file));
    const accepted = sized.filter(isAttachmentFileReadable);
    if (unreadable.length) {
      // TIPS: 模型不可读的二进制文件（如 zip）在 Electron 环境下可通过 webUtils 获取完整路径，
      // 直接将路径作为文本插入输入框（类似终端粘贴路径），而非弹警告拒绝。
      const electronBridge = (window as Window & {
        __JUGGLEWORK_ELECTRON__?: { file?: { getPathForFile?: (file: File) => string } };
      }).__JUGGLEWORK_ELECTRON__;
      const paths = unreadable
        .map((file) => {
          // 优先使用 Electron 32+ 的 webUtils.getPathForFile（替代已废弃的 File.path）
          try {
            const p = electronBridge?.file?.getPathForFile?.(file);
            if (typeof p === "string" && p.trim()) return p.trim();
          } catch {
            // fallthrough to legacy
          }
          // 回退：旧版 Electron 的 File.path 扩展属性
          const legacy = (file as File & { path?: unknown }).path;
          return typeof legacy === "string" && legacy.trim() ? legacy.trim() : null;
        })
        .filter((p): p is string => p !== null);

      if (paths.length) {
        setComposerDraft(
          props.sessionId,
          `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${paths.join("\n")}`,
        );
      } else {
        toast.warning(
          unreadable.length === 1
            ? `${unreadable[0]?.name ?? "File"} has a format the model can't read`
            : `${unreadable.length} files have formats the model can't read`,
          { description: t("composer.any_file_type_supported") },
        );
      }
    }
    if (!accepted.length) return;
    const next = accepted.map((file) => {
      const metadata = resolveAttachmentFileMetadata(file);
      return {
        id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        name: file.name,
        mimeType: metadata.mime,
        size: file.size,
        kind: metadata.kind,
        file,
        previewUrl: metadata.kind === "image" ? URL.createObjectURL(file) : undefined,
      };
    });
    setComposerAttachments(props.sessionId, [...attachments, ...next]);
    // Inline attachment chips live in the draft as Lexical tokens (same
    // pattern as pasted-text chips), so they sit in the text flow.
    setComposerDraft(
      props.sessionId,
      `${draft}${next.map((attachment) => `[attachment ${attachment.id}]`).join("")}`,
    );
  };

  const handleRemoveAttachment = (id: string) => {
    const target = attachments.find((item) => item.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    setComposerAttachments(props.sessionId, attachments.filter((item) => item.id !== id));
    setComposerDraft(props.sessionId, draft.replaceAll(`[attachment ${id}]`, ""));
  };

  /**
   * 登记一枚能力标签的展开文案
   * TIPS: 同一能力重复插入只保留一份登记；名称+种类构成唯一键。
   */
  const handleRegisterCapability = (capability: ComposerCapabilityPart) => {
    const exists = capabilities.some(
      (item) => item.kind === capability.kind && item.name === capability.name && item.prompt === capability.prompt,
    );
    if (exists) return;
    const next = capabilities.filter(
      (item) => !(item.kind === capability.kind && item.name === capability.name),
    );
    setComposerCapabilities(props.sessionId, [...next, capability]);
  };

  const handleInsertMention = (kind: ComposerMentionKind, value: string) => {
    // @agent mentions switch the session agent instead of inserting an agent
    // part. Agent parts are treated as *subagent* (task tool) calls by the
    // engine, which silently fails for primary agents and left every reply
    // coming from the default agent (#2101).
    if (kind === "agent") {
      setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, ""));
      props.onSelectAgent(value);
      toast.success(t("composer.agent_selected", { agent: value }));
      return;
    }
    setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, `@${encodeComposerMentionValue(value)} `));
    setComposerMentions(props.sessionId, { ...mentions, [value]: kind });
    // Pre-flight Computer Use permissions when an app is mentioned so missing
    // Accessibility / Screen Recording grants surface before send, not as a
    // mid-task failure. Only ever runs on macOS desktop (apps aren't offered
    // elsewhere); errors are silently ignored.
    if (kind === "app") {
      void (async () => {
        try {
          const status = (await desktopBridge.checkComputerUsePermissions()) as { ok?: boolean };
          if (status.ok === true) return;
          toast.warning(t("composer.computer_use_permissions_missing", { app: value }), {
            action: {
              label: t("composer.computer_use_permissions_setup"),
              onClick: () => void desktopBridge.openComputerUsePermissionSetup(),
            },
          });
        } catch {
          // Desktop bridge unavailable — nothing to pre-flight.
        }
      })();
    }
  };

  const handlePasteText = (text: string) => {
    const id = `paste-${Math.random().toString(36).slice(2)}`;
    const label = `${id.slice(-4)} · ${text.split(/\r?\n/).length} lines`;
    setComposerPasteParts(props.sessionId, [...pasteParts, { id, label, text, lines: text.split(/\r?\n/).length }]);
    setComposerDraft(props.sessionId, `${draft}[pasted text ${label}]`);
  };

  const handleExpandPastedText = (id: string) => {
    const part = pasteParts.find((item) => item.id === id);
    if (!part) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${part.label}]`, part.text));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  };

  const handleRemovePastedText = (id: string) => {
    const target = pasteParts.find((item) => item.id === id);
    if (!target) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${target.label}]`, ""));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    setComposerDraft(props.sessionId, `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  const typeComposerText = useCallback(async (text: string) => {
    window.dispatchEvent(new Event("jugglework:focusPrompt"));
    setComposerDraft(props.sessionId, text);
    await waitForControl(40);
  }, [props.sessionId, setComposerDraft]);

  useEffect(() => {
    const handleVoiceTranscript = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || Array.isArray(detail) || !("text" in detail) || typeof detail.text !== "string") return;
      const text = detail.text;
      void typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      recordInspectorEvent("voice.transcript.applied", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        length: text.length,
      });
    };
    window.addEventListener("jugglework:voice-transcript", handleVoiceTranscript);
    return () => window.removeEventListener("jugglework:voice-transcript", handleVoiceTranscript);
  }, [attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  const composerSetTextControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "composer.set_text",
    label: "Type into the composer",
    description: "Replace the current session draft and type the supplied text visibly.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Prompt text to place in the composer." }],
    previewArgs: { text: DEFAULT_COMPOSER_CONTROL_TEXT },
    targetRef: composerShellRef,
    execute: async (args, helpers) => {
      const text = controlTextArgument(args);
      helpers.setNarration(`Typing ${text.length.toLocaleString()} characters into the composer…`);
      await typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      return { draftLength: text.length };
    },
  }), [attachments, buildDraft, props.onDraftChange, typeComposerText]);
  useControlAction(props.isControlTarget ? composerSetTextControlAction : null);

  const composerSendControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "composer.send",
    label: "Send the composer prompt",
    description: "Send the currently visible composer draft to the active session.",
    sideEffect: "mutation",
    disabled: chatStreaming || props.taskSubmissionDisabled || props.modelUnavailable || (!draft.trim() && attachments.length === 0) || model.transitionState !== "idle",
    targetRef: composerShellRef,
    execute: async () => {
      await handleSend();
      return true;
    },
  }), [attachments.length, chatStreaming, draft, handleSend, model.transitionState, props.modelUnavailable, props.taskSubmissionDisabled]);
  useControlAction(props.isControlTarget ? composerSendControlAction : null);

  const composerStopControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "composer.stop",
    label: "Stop the current run",
    description: "Stop the current streaming session run.",
    sideEffect: "mutation",
    disabled: !chatStreaming,
    targetRef: composerShellRef,
    execute: async () => {
      await handleAbort();
      return true;
    },
  }), [chatStreaming, handleAbort]);
  useControlAction(props.isControlTarget ? composerStopControlAction : null);

  const loadConnectCapabilityInventory = useCallback(async (options?: { refresh?: boolean }): Promise<ConnectCapabilityInventory> => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const organizationId = settings.activeOrgId?.trim() ?? "";
    if (!token || !organizationId) return EMPTY_CONNECT_CAPABILITY_INVENTORY;

    const scope = `${settings.baseUrl}\n${organizationId}`;
    if (!options?.refresh && connectInventoryCacheRef.current?.scope === scope) {
      try {
        return await connectInventoryCacheRef.current.promise;
      } catch {
        connectInventoryCacheRef.current = null;
        return EMPTY_CONNECT_CAPABILITY_INVENTORY;
      }
    }

    const client = createDenClient({ baseUrl: settings.baseUrl, token });
    const promise = listAssignedConnectCapabilities({ client, organizationId });
    connectInventoryCacheRef.current = { scope, promise };
    try {
      return await promise;
    } catch {
      if (connectInventoryCacheRef.current?.promise === promise) {
        connectInventoryCacheRef.current = null;
      }
      return EMPTY_CONNECT_CAPABILITY_INVENTORY;
    }
  }, []);

  const listCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    const localCommands = withBuiltinSlashCommands(
      await props.listCommands(),
      [
        {
          id: "builtin:new",
          name: "new",
          description: t("session.cmd_new_session_detail"),
          source: "command",
        },
        {
          id: "builtin:compact",
          name: "compact",
          description: t("app.compact_command_desc"),
          source: "command",
        },
      ],
    );
    try {
      const [connect, config] = await Promise.all([
        loadConnectCapabilityInventory(),
        props.client.getConfig(props.workspaceId),
      ]);
      const importedPluginIds = new Set(Object.keys(readWorkspaceCloudImports(config.jugglework).plugins));
      const localNames = new Set(localCommands.map((command) => command.name.trim().toLowerCase()));
      const cloudCommands = connect.commands.filter((command) =>
        !importedPluginIds.has(command.connectPluginId) && !localNames.has(command.name.trim().toLowerCase())
      );
      return [...localCommands, ...cloudCommands];
    } catch {
      // Cloud inventory is optional: losing access to Connect must not hide local commands.
      return localCommands;
    }
  }, [loadConnectCapabilityInventory, props.client, props.listCommands, props.workspaceId]);

  const listSkills = async (): Promise<SkillCard[]> => {
    const [response, connect, config] = await Promise.all([
      props.client.listSkills(props.workspaceId, { includeGlobal: true }),
      loadConnectCapabilityInventory(),
      props.client.getConfig(props.workspaceId),
    ]);
    const localSkills = (response.items ?? []).map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description,
      trigger: skill.trigger,
      scope: skill.scope,
      origin: "local",
    } satisfies SkillCard));
    const importedPluginIds = new Set(Object.keys(readWorkspaceCloudImports(config.jugglework).plugins));
    const localSkillNames = new Set(localSkills.map((skill) => skill.name.trim().toLowerCase()));
    const cloudSkills = connect.skills.filter((skill) =>
      !importedPluginIds.has(skill.connectPluginId) && !localSkillNames.has(skill.name.trim().toLowerCase())
    );
    const next = [...localSkills, ...cloudSkills];
    setToolSkills(next);
    return next;
  };

  const listMcp = async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
    // fix(L3): OAuth 可能在会话保持挂载时完成，按账号范围缓存会继续返回授权前清单。
    // before: MCP 菜单复用旧 Promise；after: 每次展开菜单都刷新云端投影。
    // TIPS：命令和技能仍复用缓存，只有对授权时效敏感的 MCP 菜单强制刷新。
    const connectPromise = loadConnectCapabilityInventory({ refresh: true });
    const response = await props.client.listMcp(props.workspaceId);
    const localServers = (response.items ?? []).filter((entry) => entry.name !== "jugglework-cloud").map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      origin: "local",
    } satisfies McpServerEntry));

    let localStatuses: McpStatusMap = {};
    try {
      if (props.workspaceRoot.trim()) {
        localStatuses = unwrap(await opencodeClient.mcp.status({ directory: props.workspaceRoot.trim() })) as McpStatusMap;
      }
    } catch {
      localStatuses = {};
    }

    const connect = await connectPromise;
    // TIPS: 插件装到工作区后，同一个 stdio MCP 在两份清单里各有一条（能力目录 + 本地配置），
    // 这里认亲去重，只留本地那条并带上插件归属；没装下来的仍单独列出并标为未安装。
    const merged = mergeConnectLocalMcpServers({
      localServers,
      connectServers: connect.mcpServers,
      localStatuses,
    });
    let disabledServerNames: string[] = [];
    let cloudPolicy: import("@/app/lib/den").DenMcpWorkspaceConnectionPolicy[] = [];
    try {
      disabledServerNames = (await props.client.getMcpToolPolicy(props.workspaceId)).disabledServerNames;
    } catch {
      // 旧服务端或远程引擎不支持普通 MCP 软策略；保持列表可用。
    }
    try {
      const settings = readDenSettings();
      const token = settings.authToken?.trim() ?? "";
      const organizationId = settings.activeOrgId?.trim() ?? "";
      const workspaceKey = token && organizationId ? await resolveWorkspaceMcpKey(props.client, props.workspaceId) : null;
      if (token && organizationId && workspaceKey) {
        cloudPolicy = (await createDenClient({ baseUrl: settings.baseUrl, token })
          .getMcpWorkspacePolicy(organizationId, workspaceKey)).items;
      }
    } catch {
      // Cloud policy 暂时不可用时保留 org-level 状态；执行链路仍由服务端 fail closed。
    }
    // 与右侧连接器保持同一用户可管理集合：Connect Marketplace 插件内部 MCP
    // 不在输入栏单独展开；独立 Cloud connection 保留，快速目录补齐未连接项。
    const configuredNames = new Set(merged.servers.map((entry) => entry.name.trim().toLowerCase()));
    const manageableCloud = merged.servers.filter(isComposerManageableMcpEntry);
    const directoryServers: McpServerEntry[] = MCP_QUICK_CONNECT
      .filter((entry) => isMcpConnectorEntry(entry) && getMcpServerName(entry) !== "jugglework-cloud")
      .filter((entry) => !configuredNames.has(getMcpServerName(entry).toLowerCase()))
      .map((entry) => ({
        name: entry.name,
        localServerName: getMcpServerName(entry),
        config: entry.type === "local"
          ? { type: "local", command: entry.command }
          : { type: "remote", url: entry.url },
        origin: "local",
      }));
    const combinedStatuses: McpStatusMap = { ...connect.mcpStatuses, ...merged.statuses, ...localStatuses };
    for (const entry of directoryServers) {
      combinedStatuses[entry.name] = { status: "not_installed" };
    }
    const projected = applyWorkspaceMcpInventoryPolicy({
      servers: selectEffectiveMcpEntries([...manageableCloud, ...directoryServers].filter((entry) => !isInternalCloudMcpTransport(entry))),
      statuses: combinedStatuses,
      disabledServerNames,
      cloudPolicy,
    });
    const servers = selectComposerAvailableMcpEntries(projected);
    const statuses = projected.statuses;
    const status = servers.length ? null : "No MCP servers loaded.";
    setToolMcpServers(servers);
    setToolMcpStatuses(statuses);
    setToolMcpStatus(status);

    // Quiet self-heal: remote OAuth connectors whose access token expired
    // show "Sign in needed" even though the stored refresh token still
    // works. `mcp.connect` retries the refresh grant on a fresh transport
    // without ever opening a browser; on success the badge flips live.
    const directory = props.workspaceRoot.trim();
    if (directory && localServers.length) {
      void attemptSilentMcpReauth({
        client: opencodeClient,
        directory,
        servers: localServers,
        statuses: localStatuses,
      })
        .then(async (attempted) => {
          if (!attempted) return;
          const healed = unwrap(await opencodeClient.mcp.status({ directory })) as McpStatusMap;
          setToolMcpStatuses({ ...connect.mcpStatuses, ...merged.statuses, ...healed });
        })
        .catch(() => {
          // Best-effort; the manual Sign in path is unaffected.
        });
    }

    return { servers, statuses, status };
  };

  const listImportedPlugins = async (): Promise<CloudImportedPlugin[]> => {
    const response = await props.client.getConfig(props.workspaceId);
    const plugins = Object.values(readWorkspaceCloudImports(response.jugglework).plugins)
      .sort((left, right) => left.name.localeCompare(right.name));
    setToolImportedPlugins(plugins);
    return plugins;
  };

  const handleUploadInboxFiles = async (files: File[]) => {
    const input = files.filter(Boolean);
    if (!input.length) return;
    try {
      const results = await Promise.all(input.map((file) => props.client.uploadInbox(props.workspaceId, file)));
      return results;
    } catch (nextError) {
      toast.warning(nextError instanceof Error ? nextError.message : "Shared folder upload failed");
      throw nextError;
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionScroll = useSessionScrollController({
    selectedSessionId: props.sessionId,
    renderedMessages,
    containerRef: scrollRef,
    contentRef,
  });

  const handleFindBeforeJump = useCallback(() => {
    sessionScroll.markScrollGesture(scrollRef.current);
  }, [sessionScroll.markScrollGesture]);

  const handleFindSurfaceInteraction = useCallback(() => {
    setFindLastFocused(props.sessionId);
  }, [props.sessionId, setFindLastFocused]);

  const handleFindShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "f") return;

    event.preventDefault();
    if (resolveFindOwnerSessionId() === props.sessionId) {
      useSessionFindStore.getState().openFind({ sessionId: props.sessionId });
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleFindShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const state = useSessionFindStore.getState();
    if (state.open && state.sessionId && state.sessionId !== props.sessionId && !isSessionSurfaceMounted(state.sessionId)) {
      state.closeFind();
    }
  }, [props.sessionId]);

  const sessionIdRef = useRef(props.sessionId);
  useEffect(() => {
    sessionIdRef.current = props.sessionId;
  }, [props.sessionId]);
  useEffect(() => () => {
    const state = useSessionFindStore.getState();
    if (state.sessionId === sessionIdRef.current) {
      state.closeFind();
    }
  }, []);

  const handleMessageListDispatchAction = useCallback((action: DispatchAction) => {
    if (action.target === "settings" && action.action === "open") {
      props.onOpenSettingsSection?.(action.section);
    }
  }, [props.onOpenSettingsSection]);

  const handleMessageListSetPrompt = useCallback((prompt: string) => {
    void typeComposerText(prompt);
  }, [typeComposerText]);

  useEffect(() => {
    const resetReconnectState = () => {
      useChatMcpReconnectStore.getState().reset();
      connectInventoryCacheRef.current = null;
      setToolSkills((current) => current.filter((skill) => skill.origin !== "jugglework-connect"));
      setToolMcpServers((current) => current.filter((server) => server.origin !== "jugglework-connect"));
      setToolMcpStatuses((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith("jugglework-connect:")),
      ));
    };
    window.addEventListener(denSettingsChangedEvent, resetReconnectState);
    return () => window.removeEventListener(denSettingsChangedEvent, resetReconnectState);
  }, []);

  const handleMcpReconnect = useCallback(async (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ): Promise<ChatToolReconnectResult> => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const organizationId = settings.activeOrgId?.trim() ?? "";
    if (!token || !organizationId) {
      props.onOpenConnect();
      throw new Error("Sign in to JuggleWork Cloud, then try reconnecting again.");
    }

    const scope: ChatMcpReconnectScope = {
      baseUrl: settings.baseUrl,
      token,
      organizationId,
    };
    const currentScope = (): ChatMcpReconnectScope => {
      const current = readDenSettings();
      return {
        baseUrl: current.baseUrl,
        token: current.authToken?.trim() ?? "",
        organizationId: current.activeOrgId?.trim() ?? "",
      };
    };
    try {
      const denClient = createDenClient({ baseUrl: settings.baseUrl, token });
      const connections = await denClient.listMcpConnections(organizationId, "usable");
      const connection = connections.find((entry) => entry.id === action.connectionId);
      if (!connection || connection.authType !== "oauth" || connection.credentialMode !== "per_member") {
        throw new Error(`${action.connectionName} is no longer available as your reconnectable account.`);
      }

      recordInspectorEvent("mcp.chat_reconnect.started", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
      });
      onProgress({ phase: "opening" });
      const result = await denClient.startMcpConnectionConnect(organizationId, action.connectionId);
      if (result.status === "connected") {
        recordInspectorEvent("mcp.chat_reconnect.completed", {
          workspaceId: props.workspaceId,
          sessionId: props.sessionId,
          connectionId: action.connectionId,
          completion: "already_connected",
        });
        return "connected";
      }
      if (!result.authorizeUrl) throw new Error(`Could not start ${action.connectionName} authorization.`);

      await openDesktopUrl(result.authorizeUrl);
      onProgress({ phase: "authorization_opened", authorizeUrl: result.authorizeUrl });
      await waitForFreshMcpAuthorization({
        connectionId: action.connectionId,
        connectionName: action.connectionName,
        previousConnectedAt: connection.connectedAt,
        listConnections: () => denClient.listMcpConnections(organizationId, "usable"),
        isScopeCurrent: () => isChatMcpReconnectScopeCurrent(scope, currentScope()),
      });
      recordInspectorEvent("mcp.chat_reconnect.completed", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
        completion: "fresh_authorization",
      });
      return "connected";
    } catch (error) {
      recordInspectorEvent("mcp.chat_reconnect.failed", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        connectionId: action.connectionId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }, [props.onOpenConnect, props.sessionId, props.workspaceId]);

  const handleMcpReopenAuthorization = useCallback(async (
    action: ChatToolReconnectAction,
    authorizeUrl: string,
  ) => {
    await openDesktopUrl(authorizeUrl);
    recordInspectorEvent("mcp.chat_reconnect.authorization_reopened", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      connectionId: action.connectionId,
    });
  }, [props.sessionId, props.workspaceId]);

  const handleMcpRetry = useCallback(async (action: ChatToolReconnectAction) => {
    const prompt = `The ${action.connectionName} connection is restored. Search for the capability again and retry the previous request. Before repeating any write action, confirm it did not already complete.`;
    await typeComposerText(prompt);
    props.onDraftChange(buildDraft(prompt, attachments));
    recordInspectorEvent("mcp.chat_reconnect.retry_drafted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      connectionId: action.connectionId,
    });
  }, [attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  const handleRevertToUserMessage = useCallback((messageId: string) => {
    void props.onRevertToMessage?.(messageId, props.sessionId);
  }, [props.onRevertToMessage, props.sessionId]);

  const handleForkAtMessage = useCallback((messageId: string) => {
    // OpenCode's fork copies messages strictly before the given id, so pass
    // the next real message to make the branch include the clicked message.
    props.onForkAtMessage?.(resolveForkBoundaryId(renderedMessages, messageId), props.sessionId);
  }, [props.onForkAtMessage, props.sessionId, renderedMessages]);

  const handleEditUserMessage = useCallback((messageId: string, text: string) => {
    void (async () => {
      // Rewind the session to just before this prompt, then restore the
      // prompt text into the composer so the user can rewrite and resend it.
      const reverted = await props.onRevertToMessage?.(messageId, props.sessionId);
      if (reverted === false) return;
      await typeComposerText(text);
    })();
  }, [props.onRevertToMessage, props.sessionId, typeComposerText]);

  const sessionScrollTopControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "session.scroll_top",
    label: "Go to the top of the session",
    description: "Scroll the visible session transcript to the first messages.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    execute: () => {
      const container = scrollRef.current;
      if (!container) return { ok: false, error: "Session transcript is not mounted" };
      container.scrollTo({ top: 0, behavior: "smooth" });
      return { ok: true, position: "top" };
    },
  }), []);
  useControlAction(props.isControlTarget ? sessionScrollTopControlAction : null);

  const sessionScrollBottomControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "session.scroll_bottom",
    label: "Go to the bottom of the session",
    description: "Scroll the visible session transcript to the newest messages and composer area.",
    effects: { data: "none", ui: "focus", external: false },
    sideEffect: "none",
    execute: () => {
      sessionScroll.jumpToLatest("smooth");
      return { ok: true, position: "bottom" };
    },
  }), [sessionScroll.jumpToLatest]);
  useControlAction(props.isControlTarget ? sessionScrollBottomControlAction : null);

  const sessionLatestMessageControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "session.latest_message",
    label: "Read the latest session message",
    description: "Return the latest visible message in the current session transcript.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => {
      const message = renderedMessages[renderedMessages.length - 1];
      if (!message) return { ok: false, error: "No messages are visible in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        index: renderedMessages.length - 1,
        role: message.role,
        text: messageToReadableText(message),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(props.isControlTarget ? sessionLatestMessageControlAction : null);

  const sessionReadTranscriptControlAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "session.read_transcript",
    label: "Read the current session transcript",
    description: "Return the last messages from the current session transcript as readable text, including the session ID, title, and message count.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [{ name: "count", type: "number", required: false, description: "Number of recent messages to return, from 1 to 30. Defaults to 10." }],
    execute: (args) => {
      const count = typeof args === "object" && args !== null && "count" in args && typeof (args as { count?: unknown }).count === "number"
        ? Math.min(Math.max(1, (args as { count: number }).count), 30)
        : 10;
      const total = renderedMessages.length;
      const slice = renderedMessages.slice(-count);
      if (!slice.length) return { ok: false, error: "No messages in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        messageCount: total,
        returned: slice.length,
        messages: slice.map((message, index) => ({
          index: total - slice.length + index,
          role: message.role,
          text: messageToReadableText(message),
        })),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(props.isControlTarget ? sessionReadTranscriptControlAction : null);

  return (
    <DevProfiler id="SessionSurface">
    <div
      data-session-surface-id={props.sessionId}
      onPointerDownCapture={handleFindSurfaceInteraction}
      onFocusCapture={handleFindSurfaceInteraction}
      className="flex h-full min-h-0 flex-col"
    >
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onWheel={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchStart={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchMove={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            sessionScroll.markScrollGesture(event.currentTarget);
          }}
          onScroll={sessionScroll.handleScroll}
          // Extra top padding while the find bar is open so it never covers
          // the first message (short transcripts cannot scroll it clear).
          className={`subtle-scrollbar absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 pb-4 sm:px-5 ${findOwned ? "pt-16" : "pt-4"}`}
        >
          {/* Chat column: tighter than the composer (800px) so messages
               keep a comfortable reading width and don't feel "too big". */}
          <div ref={contentRef} className="mx-auto w-full max-w-[720px]">
            {showDelayedLoading && pendingSessionLoad ? (
              <div className="px-6 py-16">
                <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
                  <div className="text-sm text-dls-secondary">Opening session…</div>
                </div>
              </div>
            ) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
              <div className="px-6 py-8">
                {error ? (
                  <SessionErrorCard
                    error={error}
                    onDismiss={handleDismissError}
                    onChangeModel={props.onChangeModel}
                    onOpenModelPicker={props.onModelClick}
                  />
                ) : (
                  <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
                    {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load session."}
                  </div>
                )}
              </div>
            ) : renderedMessages.length === 0 && effectiveActivityStatus !== "idle" ? (
              <div className="px-6 py-12">
                <AssistantWaitingCard label={getSessionActivityStatusLabel(effectiveActivityStatus)} />
              </div>
            ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 && error ? (
              <SessionErrorCard
                error={error}
                onDismiss={handleDismissError}
                onChangeModel={props.onChangeModel}
                onOpenModelPicker={props.onModelClick}
              />
            ) : (
              <DevProfiler id="MessageList">
                <OpenTargetProvider
                  openTargets={verifiedOpenTargets}
                  onOpenTarget={props.onOpenTarget}
                >
                  <EnvironmentVariableProvider
                    client={props.isRemoteWorkspace ? null : props.environmentClient ?? props.client}
                    runtimeKey={props.environmentRuntimeKey}
                    onApplyChanges={props.onApplyEnvironmentChanges}
                  >
                    <MessageListProvider
                      workspaceId={props.workspaceId}
                      sessionId={props.sessionId}
                      showThinking={showThinking}
                      highlightQuery={findHighlightQuery}
                      developerMode={props.developerMode}
                      displaySuggestions={shellConfig.starterCards}
                      providerConnectedCount={props.providerConnectedCount ?? 0}
                      dispatchAction={handleMessageListDispatchAction}
                      setPrompt={handleMessageListSetPrompt}
                      onRevertToUserMessage={handleRevertToUserMessage}
                      onForkAtMessage={handleForkAtMessage}
                      onEditUserMessage={handleEditUserMessage}
                      onMcpReconnect={handleMcpReconnect}
                      onMcpReopenAuthorization={handleMcpReopenAuthorization}
                      onMcpRetry={handleMcpRetry}
                    >
                      <MessageList
                        messages={renderedMessages}
                        status={status}
                        retryStatus={liveStatus.type === "retry" ? liveStatus : null}
                        compactionRunning={effectiveActivityStatus === "compacting"}
                      />
                    </MessageListProvider>
                  </EnvironmentVariableProvider>
                </OpenTargetProvider>
              </DevProfiler>
            )}
          </div>
        </div>
        <SessionScrollOverlay
          sessionId={props.sessionId}
          isStreaming={chatStreaming}
          onJumpToLatest={sessionScroll.jumpToLatest}
          onJumpToStartOfMessage={sessionScroll.jumpToStartOfMessage}
        />
        <SessionFindBar
          sessionId={props.sessionId}
          scrollRef={scrollRef}
          onBeforeJump={handleFindBeforeJump}
        />
      </div>

      <div ref={composerShellRef} className="shrink-0 px-0 pb-2">
        {(props.providerConnectedCount ?? 0) === 0 ? (
          <button
            type="button"
            className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-amber-7/40 bg-amber-2/30 px-3 py-2 text-left text-xs text-amber-11 transition-colors hover:bg-amber-3/40"
            onClick={() => props.onOpenSettingsSection?.("providers")}
          >
            <span className="font-medium">No AI model connected.</span>
            <span className="text-amber-11/70">Add a provider to run tasks.</span>
          </button>
        ) : null}
        <DevProfiler id="SessionComposer">
        {props.cloudMcpSubmissionState.status === "failed" ? (
          <div
            className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-red-7/40 bg-red-2/40 px-3 py-2 text-xs text-red-11"
            data-testid="cloud-mcp-submission-failure"
          >
            <span className="min-w-0 flex-1">
              {[
                props.cloudMcpSubmissionState.issue?.message ?? "Connected service tools could not be prepared.",
                props.cloudMcpSubmissionState.issue?.recommendedAction,
              ].filter(Boolean).join(" ")}
            </span>
            <button type="button" className="font-medium hover:underline" onClick={handleRetryCloudSubmission}>
              Retry
            </button>
            <button type="button" className="font-medium hover:underline" onClick={props.onOpenConnect}>
              Open Connect
            </button>
          </div>
        ) : null}
        {error && renderedMessages.length > 0 ? (
          <SessionErrorCard
            error={error}
            onDismiss={handleDismissError}
            onChangeModel={props.onChangeModel}
            onOpenModelPicker={props.onModelClick}
          />
        ) : null}
        <ReactSessionComposer
          draft={draft}
          mentions={mentions}
          onDraftChange={handleComposerDraftChange}
        onSend={handleSend}
        onSteer={handleSteer}
        onQueue={handleQueue}
        onStop={handleAbort}
        busy={chatStreaming}
        steering={steering}
        submissionPreparing={preparingCloudTools}
        submissionDisabled={Boolean(props.taskSubmissionDisabled)}
        queuedCount={queuedDrafts.length}
        disabled={model.transitionState !== "idle" || Boolean(props.modelUnavailable)}
        modelUnavailable={Boolean(props.modelUnavailable)}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelPickerOpen={props.modelPickerOpen}
        selectedModel={props.selectedModel}
        contextUsageMessages={snapshot?.messages ?? []}
        contextUsageTranscript={contextEstimationMessages}
        contextWindowTokens={props.contextWindowTokens}
        onModelPickerOpenChange={props.onModelPickerOpenChange}
        onModelChange={props.onModelChange}
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentsEnabled={props.attachmentsEnabled}
        attachmentsDisabledReason={props.attachmentsDisabledReason}
        modelVariantLabel={props.modelVariantLabel}
        modelVariant={props.modelVariant}
        modelBehaviorOptions={props.modelBehaviorOptions}
        onModelVariantChange={props.onModelVariantChange}
        agentLabel={props.agentLabel}
        selectedAgent={props.selectedAgent}
        listAgents={props.listAgents}
        onSelectAgent={props.onSelectAgent}
        listCommands={listCommands}
        listSkills={listSkills}
        skills={toolSkills}
        listMcp={listMcp}
        mcpServers={toolMcpServers}
        mcpStatus={toolMcpStatus}
        mcpStatuses={toolMcpStatuses}
        listImportedPlugins={listImportedPlugins}
        importedPlugins={toolImportedPlugins}
        recentFiles={props.recentFiles}
        searchFiles={props.searchFiles}
        onInsertMention={handleInsertMention}
        onRegisterCapability={handleRegisterCapability}
        inputHistory={inputHistory}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onExpandPastedText={handleExpandPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
          topAccessory={
            props.activeQuestion || showTaskProgress || props.activePermission || queuedDrafts.length > 0 ? (
              <div>
                {queuedDrafts.length > 0 ? (
                  <QueuedMessagesPanel
                    drafts={queuedDrafts}
                    onRemove={removeQueuedDraft}
                    onEdit={editQueuedDraft}
                    sending={drainingQueueRef.current}
                  />
                ) : null}
                {props.activeQuestion ? (
                  <QuestionPanel
                    questions={props.activeQuestion.questions}
                    busy={props.questionReplyBusy ?? false}
                    onReply={(answers) => {
                      if (props.activeQuestion) {
                        props.respondQuestion?.(props.activeQuestion.id, answers);
                      }
                    }}
                  />
                ) : showTaskProgress ? (
                  <TodoPanel todos={todos} />
                ) : null}
                {props.activePermission ? (
                  <PermissionApprovalPanel
                    permission={props.activePermission}
                    busy={props.permissionReplyBusy}
                    respondPermission={props.respondPermission}
                    safeStringify={props.safeStringify}
                  />
                ) : null}
              </div>
            ) : null
          }
        />
        </DevProfiler>
      </div>
      {/* Error display moved inline into the session conversation area */}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
    </DevProfiler>
  );
}
