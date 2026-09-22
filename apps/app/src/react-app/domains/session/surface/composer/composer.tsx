/** @jsxImportSource react */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";
import { AppWindowMac, ArrowUp, Check, FileCog, FileText, ImagePlus, Lightbulb, LoaderCircle, MessageCirclePlus, Mic, Minimize2, Paperclip, PenLine, Plus, Plug, ScanSearch, Square, SquarePlay, Terminal, X, Zap } from "lucide-react";
import fuzzysort from "fuzzysort";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { JUGGLEWORK_EXTENSION_CATALOG, type McpDirectoryInfo } from "@/app/constants";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "@/app/cloud/import-state";
import type { JuggleWorkServerClient, JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ComposerAttachment, ComposerImageGenerationOptions, ComposerVideoGenerationOptions, McpServerEntry, McpStatus, McpStatusMap, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
import { t } from "@/i18n";
import { isJuggleWorkExtensionEnabled, isJuggleWorkExtensionHidden, JUGGLEWORK_EXTENSION_STATE_CHANGED } from "@/react-app/domains/settings/extension-state";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { ModelBehaviorSelect } from "@/components/model-behavior-select";
import { ModelSelect } from "@/components/model-select";
import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge";
import { LexicalPromptEditor, type LexicalPromptEditorHandle } from "./editor";
import { listRunningAppsForMention } from "./app-mentions";
import type { ComposerMentionKind } from "./mention-encoding";
import {
  buildCapabilityInstruction,
  composerCapabilityToken,
  resolveMcpCapabilitySelection,
  type ComposerCapabilityKind,
} from "./capability-tags";
import {
  connectSkillSlashCommandOptions,
  getSlashCommandQuery,
  skillMenuSlashCommandName,
  skillSlashCommandName,
  type ComposerSlashCommandOption,
} from "./slash-command";
import { FILE_URL_RE, HTTP_URL_RE } from "./pasted-text";
import { resolveComposerSubmitAction } from "../queued-draft-policy";
import { ContextUsage } from "./context-usage";
import { ImageGenerationControls } from "./image-generation-controls";
import type { ComposerImageModelOption } from "./image-generation";
import { VideoGenerationControls } from "./video-generation-controls";
import type { ComposerVideoModelOption } from "./video-generation";
import {
  COMPOSER_FOCUS_REQUEST_EVENT,
  completeComposerFocusRequest,
  getPendingComposerFocusRequest,
} from "./focus-request";
import {
  VoiceDictationController,
  type VoiceDictationErrorCode,
  type VoiceDictationSnapshot,
} from "./voice-dictation";

const SketchDialog = lazy(() =>
  import("./sketch/sketch-dialog").then((module) => ({ default: module.SketchDialog })),
);

type MentionItem = {
  id: string;
  kind: ComposerMentionKind;
  value: string;
  label: string;
};

type PastedTextChip = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

/**
 * 统一加号菜单的条目。
 * 所有能力均在同一层展示；插件和 MCP 不再打开右侧二级面板。
 */
type PlusMenuEntry =
  | { kind: "file"; id: "file"; label: string; description: string }
  | { kind: "sketch"; id: "sketch"; label: string; description: string }
  | { kind: "image-generation"; id: "image-generation"; label: string; description: string }
  | { kind: "video-generation"; id: "video-generation"; label: string; description: string }
  | { kind: "agent"; id: string; label: string; description: string; name: string | null }
  | { kind: "extension"; id: string; label: string; description: string; extension: McpDirectoryInfo }
  | { kind: "plugin-file"; id: string; label: string; description: string; file: CloudImportedPluginFile }
  | { kind: "mcp"; id: string; label: string; description: string; entry: McpServerEntry; status: McpServerStatus; detail: McpStatus | undefined };

function plusMenuAgentIcon(name: string | null) {
  const normalizedName = name?.trim().toLowerCase();
  if (normalizedName === "plan") {
    return <Lightbulb size={18} strokeWidth={1.8} className="shrink-0 text-gray-10" />;
  }
  return <Zap size={18} strokeWidth={1.8} className="shrink-0 text-gray-10" />;
}

type BuiltinSlashCommandName = "new" | "compact" | "init" | "review";

function builtinSlashCommandName(name: string): BuiltinSlashCommandName | null {
  const normalizedName = name.trim().toLowerCase();
  if (normalizedName === "new" || normalizedName === "compact" || normalizedName === "init" || normalizedName === "review") {
    return normalizedName;
  }
  return null;
}

function slashCommandLabel(command: ComposerSlashCommandOption, isSkill: boolean) {
  if (isSkill) return command.name;
  const builtin = builtinSlashCommandName(command.name);
  if (builtin) return t(`composer.command_${builtin}_label`);
  return `/${command.name}`;
}

function slashCommandDescription(command: ComposerSlashCommandOption, isSkill: boolean) {
  if (isSkill) return command.description || t("composer.skill_description_fallback");
  const builtin = builtinSlashCommandName(command.name);
  if (builtin) return t(`composer.command_${builtin}_description`);
  return command.description || t("composer.command_description_fallback");
}

function slashCommandIcon(command: ComposerSlashCommandOption, isSkill: boolean) {
  if (isSkill) return <Zap size={18} strokeWidth={1.8} />;
  switch (builtinSlashCommandName(command.name)) {
    case "new":
      return <MessageCirclePlus size={18} strokeWidth={1.8} />;
    case "compact":
      return <Minimize2 size={18} strokeWidth={1.8} />;
    case "init":
      return <FileCog size={18} strokeWidth={1.8} />;
    case "review":
      return <ScanSearch size={18} strokeWidth={1.8} />;
    default:
      return <Terminal size={18} strokeWidth={1.8} />;
  }
}

function isComposerExtensionAvailable(entry: McpDirectoryInfo) {
  const hasSessionSurface = entry.extensionManifest?.contributions?.some((contribution) =>
    contribution.type === "session-side-panel" || contribution.type === "session-rail-item"
  ) === true;
  if (hasSessionSurface) return isJuggleWorkExtensionEnabled(entry);
  return !entry.defaultEnabled || isJuggleWorkExtensionEnabled(entry);
}

type ComposerProps = {
  sessionId: string;
  createVoiceRealtimeSession: JuggleWorkServerClient["createVoiceRealtimeSession"] | null;
  getVoiceRealtimeStatus: JuggleWorkServerClient["getVoiceRealtimeStatus"] | null;
  onOpenVoiceSettings?: () => void;
  focusEligible: boolean;
  draft: string;
  mentions: Record<string, ComposerMentionKind>;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onSteer: () => void | Promise<void>;
  onQueue: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  busy: boolean;
  steering: boolean;
  submissionPreparing: boolean;
  submissionPreparingLabel: string | null;
  submissionDisabled: boolean;
  queuedCount: number;
  disabled: boolean;
  modelUnavailable?: boolean;
  statusLabel: string;
  modelPickerOpen: boolean;
  selectedModel: ModelRef;
  /** 当前会话的原始消息，用于读取引擎返回的真实 token 计量。 */
  contextUsageMessages: JuggleWorkSessionMessage[];
  /** 当前会话合并实时事件后的 Transcript，用于会话打开和流式阶段的上下文估算。 */
  contextUsageTranscript: UIMessage[];
  /** 当前模型声明的上下文窗口上限；0 表示模型目录未提供。 */
  contextWindowTokens: number;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  attachments: ComposerAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  imageGenerationModels: ComposerImageModelOption[];
  imageGenerationLoading: boolean;
  imageGeneration: ComposerImageGenerationOptions | null;
  onEnableImageGeneration: () => void;
  onImageGenerationChange: (value: ComposerImageGenerationOptions) => void;
  onDisableImageGeneration: () => void;
  onRefreshImageGenerationModels: () => void | Promise<unknown>;
  videoGenerationModels: ComposerVideoModelOption[];
  videoGenerationLoading: boolean;
  videoGeneration: ComposerVideoGenerationOptions | null;
  onEnableVideoGeneration: () => void;
  onVideoGenerationChange: (value: ComposerVideoGenerationOptions) => void;
  onDisableVideoGeneration: () => void;
  onRefreshVideoGenerationModels: () => void | Promise<unknown>;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  /**
   * 会话权限模式选择器（请求审批 / 完全访问）。
   * 由 SessionSurface 渲染后作为插槽传入，保持 composer 与权限状态解耦。
   */
  permissionModeSelector?: ReactNode;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<SlashCommandOption[]>;
  listSkills?: () => Promise<SkillCard[]>;
  skills?: SkillCard[];
  listMcp?: () => Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }>;
  mcpServers?: McpServerEntry[];
  mcpStatus?: string | null;
  mcpStatuses?: McpStatusMap;
  listImportedPlugins?: () => Promise<CloudImportedPlugin[]>;
  importedPlugins?: CloudImportedPlugin[];
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  onInsertMention: (kind: ComposerMentionKind, value: string) => void;
  /**
   * 登记一枚能力标签送给模型时要展开成的完整文案。
   * TIPS: 草稿里只存紧凑 token，真正的指令在 buildDraft 里按登记内容还原。
   */
  onRegisterCapability?: (capability: { kind: ComposerCapabilityKind; name: string; prompt: string }) => void;
  /** Sent-prompt history (oldest first) recalled with ArrowUp/ArrowDown (#2012). */
  inputHistory?: string[];
  onPasteText: (text: string) => void;
  onUnsupportedFileLinks: (links: string[]) => void;
  pastedText: PastedTextChip[];
  onExpandPastedText: (id: string) => void;
  onRemovePastedText: (id: string) => void;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: ((files: File[]) => void | Promise<unknown>) | null;
  draftScopeKey?: string;
  topAccessory?: ReactNode;
};

const FLUSH_PROMPT_EVENT = "jugglework:flushPromptDraft";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_COMPRESS_MAX_PX = 2048;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;
const DEFAULT_AGENT_NAME = "jugglework";

function isNonDefaultAgent(agent: Agent) {
  return agent.name !== DEFAULT_AGENT_NAME;
}

/**
 * Extract external file/URL drops from a clipboard. Only used when the user
 * drag-drops a file reference from another app (Finder / browser), which sets
 * the text/uri-list MIME type explicitly. Plain text pastes — even ones that
 * contain absolute paths like "/Users/..." — are NEVER treated as links here
 * because that intercepted real text pastes and made composer paste feel
 * broken. Plain text goes straight into the editor via Lexical's default.
 */
function parseClipboardUriList(clipboard: DataTransfer) {
  const raw = clipboard.getData("text/uri-list") ?? "";
  if (!raw.trim()) return [];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!FILE_URL_RE.test(trimmed) && !HTTP_URL_RE.test(trimmed)) continue;
    const normalized = encodeURI(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

function isImageAttachment(attachment: ComposerAttachment) {
  return attachment.kind === "image" || attachment.mimeType.startsWith("image/");
}

/** 从文件名推导类型标签（如 "1785895200000.log" -> "LOG"）。 */
function attachmentTypeLabel(name: string) {
  const match = /\.([^.\\/]+)$/.exec(name.trim());
  return match ? match[1].toUpperCase() : "FILE";
}

// 附件 token（[attachment <id>]）内嵌在草稿字符串里，是附件生命周期的真源；
// 但它不再在编辑器内联渲染——附件改由编辑器上方独立的横向行展示，
// 编辑器只保留纯文本，保证光标与 placeholder 正常。
const ATTACHMENT_TOKEN_RE = /\[attachment [^\]]+\]/g;

async function compressImageFile(file: File): Promise<File> {
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const maxDim = Math.max(width, height);
  const scale = maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({
        type: "image/jpeg",
        quality: IMAGE_COMPRESS_QUALITY,
      });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
      );
    }
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file;
  }

  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}

function formatMcpStatusLabel(status: McpServerStatus | undefined) {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "not_installed":
      return t("mcp.friendly_status_not_installed");
    case "not_configured":
      return t("mcp.friendly_status_not_configured");
    case "disconnected":
      return t("mcp.friendly_status_offline");
    case "failed":
    default:
      return t("mcp.friendly_status_issue");
  }
}

type McpServerStatus = "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "not_installed" | "not_configured" | "disconnected";

function toReactMcpStatus(name: string, entry: McpServerEntry, statuses: McpStatusMap): McpServerStatus {
  const configured = statuses[name];
  if (configured?.status === "connected") return "connected";
  if (configured?.status === "not_installed") return "not_installed";
  if (configured?.status === "not_configured") return "not_configured";
  if (configured?.status === "needs_auth") return "needs_auth";
  if (configured?.status === "needs_client_registration") return "needs_client_registration";
  if (configured?.status === "failed") return "failed";
  if (configured?.status === "disabled" || entry.config.enabled === false || entry.config.enabled === undefined && entry.config.type === "local" && entry.config.command?.length === 0) {
    return entry.config.enabled === false ? "disabled" : configured?.status === "disabled" ? "disabled" : "disconnected";
  }
  return "disconnected";
}

/**
 * MCP 状态徽标的悬浮说明。
 * TIPS: 「异常」可能来自组织未配置、市场未同步、能力未就绪等多种原因，
 * 后端给出的 error 只存在于状态原始数据里，这里补到 title 上，避免界面只剩一个同质徽标。
 * @param status 归一化后的展示状态
 * @param detail 状态原始数据（failed / needs_client_registration 会带 error）
 */
function mcpStatusTooltip(status: McpServerStatus, detail: McpStatus | undefined) {
  const label = formatMcpStatusLabel(status);
  const reason = detail && "error" in detail && typeof detail.error === "string" ? detail.error.trim() : "";
  return reason ? `${label} · ${reason}` : label;
}

function mcpStatusBadgeClass(status: McpServerStatus) {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11";
    case "not_installed":
    case "not_configured":
      return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected":
      return "bg-gray-3 text-gray-11";
    default:
      return "bg-red-3 text-red-11";
  }
}

function extensionIcon(entry: McpDirectoryInfo, size = 16) {
  const serviceUrl = typeof entry.url === "string" ? entry.url : undefined;
  const iconUrl = resolveExtensionIconUrl({ iconSrc: entry.iconSrc, iconSlug: entry.iconSlug, serviceUrl });
  if (iconUrl) {
    return <img src={iconUrl} alt="" width={size} height={size} loading="lazy" style={{ display: "block" }} />;
  }
  return <Plug size={size} className="text-gray-9" />;
}

function formatPluginObjectType(type: string) {
  const normalized = type.trim().toLowerCase();
  if (!normalized) return "File";
  if (normalized === "mcp") return "MCP";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function pluginSlashCommandName(file: CloudImportedPluginFile) {
  const path = file.path.trim();
  if (file.objectType === "command") {
    const command = path.match(/^\.opencode\/(?:command|commands)\/(.+)\.md$/i)?.[1];
    return command?.trim() || null;
  }
  if (file.objectType === "skill") {
    const skill = path.match(/^\.opencode\/(?:skill|skills)\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/i)?.[1];
    return skill?.trim() || null;
  }
  return null;
}

export function ReactSessionComposer(props: ComposerProps) {
  const builtInExtensionsDisabled = useDesktopRestriction("allowBuiltInExtensions");
  let fileInput: HTMLInputElement | undefined;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skills, setSkills] = useState<SkillCard[]>(props.skills ?? []);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>(props.mcpServers ?? []);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>(props.mcpStatuses ?? {});
  const [importedPlugins, setImportedPlugins] = useState<CloudImportedPlugin[]>(props.importedPlugins ?? []);
  const [slashOpen, setSlashOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusMenuIndex, setPlusMenuIndex] = useState(0);
  const [sketchOpen, setSketchOpen] = useState(false);
  const plusItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const commandsCacheRef = useRef<SlashCommandOption[] | null>(null);
  const commandsRequestRef = useRef<Promise<SlashCommandOption[]> | null>(null);
  const skillsRequestRef = useRef<Promise<SkillCard[]> | null>(null);
  const commandsLoadVersionRef = useRef(0);
  const listCommandsRef = useRef(props.listCommands);
  const listSkillsRef = useRef(props.listSkills);
  const listMcpRef = useRef(props.listMcp);
  const listImportedPluginsRef = useRef(props.listImportedPlugins);
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [, setExtensionStateVersion] = useState(0);
  const [dropzoneActive, setDropzoneActive] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const plusMenuPopupRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<LexicalPromptEditorHandle | null>(null);
  const voiceDictationRef = useRef<VoiceDictationController | null>(null);
  const onOpenVoiceSettingsRef = useRef(props.onOpenVoiceSettings);
  const [voiceDictation, setVoiceDictation] = useState<VoiceDictationSnapshot>({ phase: "idle" });
  const [voiceServiceAvailability, setVoiceServiceAvailability] = useState<"checking" | "available" | "unavailable">("checking");
  // IME composition guard: while an IME composition is active, we must not
  // treat Enter as a submit. Three signals keep this reliable across WebKit,
  // Chrome, and Safari: event.isComposing, event.keyCode === 229, and the
  // compositionstart/compositionend events below.
  const imeComposingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(props.draft);
  useEffect(() => {
    draftRef.current = props.draft;
  }, [props.draft]);
  useEffect(() => {
    onOpenVoiceSettingsRef.current = props.onOpenVoiceSettings;
  }, [props.onOpenVoiceSettings]);

  useEffect(() => {
    const getVoiceRealtimeStatus = props.getVoiceRealtimeStatus;
    if (!getVoiceRealtimeStatus || !props.createVoiceRealtimeSession) {
      setVoiceServiceAvailability("unavailable");
      return;
    }

    let disposed = false;
    const refresh = async () => {
      try {
        const status = await getVoiceRealtimeStatus();
        if (!disposed) setVoiceServiceAvailability(status.configured ? "available" : "unavailable");
      } catch {
        // A status probe failure should not disable a service that may still be
        // usable (for example while reconnecting to an older remote server).
        if (!disposed) setVoiceServiceAvailability("available");
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    setVoiceServiceAvailability("checking");
    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [props.createVoiceRealtimeSession, props.getVoiceRealtimeStatus]);

  useEffect(() => {
    const createVoiceRealtimeSession = props.createVoiceRealtimeSession;
    if (!createVoiceRealtimeSession) {
      voiceDictationRef.current?.dispose();
      voiceDictationRef.current = null;
      setVoiceDictation({ phase: "idle" });
      return;
    }

    const errorMessage = (code: VoiceDictationErrorCode) => {
      switch (code) {
        case "microphone_busy": return t("composer.voice_busy");
        case "permission_denied": return t("composer.voice_permission_denied");
        case "service_unavailable": return t("composer.voice_unavailable");
        case "transcription_timeout": return t("composer.voice_timeout");
        default: return t("composer.voice_failed");
      }
    };
    const controller = new VoiceDictationController({
      sessionId: props.sessionId,
      createSession: () => createVoiceRealtimeSession({ purpose: "dictation" }),
      onSnapshot: (snapshot) => {
        setVoiceDictation(snapshot);
        if (snapshot.phase === "error" && snapshot.errorCode) {
          toast.error(errorMessage(snapshot.errorCode), snapshot.errorCode === "service_unavailable" && onOpenVoiceSettingsRef.current
            ? {
              action: {
                label: t("composer.voice_open_settings"),
                onClick: () => onOpenVoiceSettingsRef.current?.(),
              },
            }
            : undefined);
        }
      },
      onTranscript: (text) => {
        if (editorRef.current) {
          editorRef.current.insertTextAtSelection(text);
          return;
        }
        props.onDraftChange(`${draftRef.current}${text}`);
      },
      onEmpty: () => toast.info(t("composer.voice_empty")),
    });
    voiceDictationRef.current = controller;

    const cancel = () => controller.cancel();
    window.addEventListener("pagehide", cancel);
    window.addEventListener("beforeunload", cancel);
    return () => {
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("beforeunload", cancel);
      controller.dispose();
      if (voiceDictationRef.current === controller) voiceDictationRef.current = null;
    };
  }, [props.createVoiceRealtimeSession, props.onDraftChange, props.sessionId]);

  const toggleVoiceDictation = useCallback(() => {
    const controller = voiceDictationRef.current;
    if (!controller) {
      toast.error(t("composer.voice_unavailable"), onOpenVoiceSettingsRef.current
        ? {
          action: {
            label: t("composer.voice_open_settings"),
            onClick: () => onOpenVoiceSettingsRef.current?.(),
          },
        }
        : undefined);
      return;
    }
    const phase = controller.getSnapshot().phase;
    if (phase === "recording") {
      void controller.stop();
      return;
    }
    if (phase === "requesting-permission" || phase === "connecting") {
      controller.cancel();
      return;
    }
    if (phase === "idle" || phase === "error") void controller.start();
  }, []);
  const voiceDictationLabel = voiceDictation.phase === "recording"
    ? t("composer.voice_stop")
    : voiceDictation.phase === "requesting-permission" || voiceDictation.phase === "connecting"
      ? t("composer.voice_connecting")
      : voiceDictation.phase === "transcribing"
        ? t("composer.voice_transcribing")
        : t("composer.voice_start");
  const voiceServiceUnavailable = voiceServiceAvailability === "unavailable";
  const voiceServiceChecking = voiceServiceAvailability === "checking";
  const voiceServiceDisabled = voiceServiceAvailability !== "available";
  const voiceButtonLabel = voiceServiceUnavailable
    ? t("composer.voice_configure_hint")
    : voiceServiceChecking
      ? t("composer.voice_checking")
      : voiceDictationLabel;

  // Follow-up message UX (only relevant while the agent is busy):
  // - Every submit queues the message to run after the current task.
  // - Escape arms a "Hit Escape again to stop the agent" prompt for 3s;
  //   a second Escape within that window stops the agent.
  const [escapeArmed, setEscapeArmed] = useState(false);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmEscape = useCallback(() => {
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = null;
    }
    setEscapeArmed(false);
  }, []);

  // Reset the escape-to-stop prompt whenever the agent stops being busy.
  useEffect(() => {
    if (!props.busy) disarmEscape();
  }, [props.busy, disarmEscape]);

  useEffect(() => {
    if (props.steering && props.modelPickerOpen) {
      props.onModelPickerOpenChange(false);
    }
  }, [props.modelPickerOpen, props.onModelPickerOpenChange, props.steering]);

  // Input history recall (#2012): ArrowUp on an empty composer recalls the
  // previous sent prompt; repeated ArrowUp/ArrowDown walk the history.
  // Editing the recalled text exits recall mode, and ArrowDown past the
  // newest entry restores whatever was typed before recall started.
  const historyPosRef = useRef<number | null>(null);
  const historyExpectedRef = useRef<string | null>(null);
  const historyStashRef = useRef("");

  useEffect(() => {
    if (historyPosRef.current === null) return;
    if (props.draft !== historyExpectedRef.current) {
      historyPosRef.current = null;
      historyExpectedRef.current = null;
    }
  }, [props.draft]);

  useEffect(() => () => {
    if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
  }, []);

  // Editor submit (Enter). While idle this sends normally; while busy every
  // submission joins the FIFO queue.
  const handleEditorSubmit = useCallback((options: { queue: boolean }) => {
    const hasContent = props.draft.trim().length > 0 || props.attachments.length > 0;
    if (!hasContent) return;
    if (props.submissionPreparing || props.submissionDisabled) return;
    if (resolveComposerSubmitAction(props.busy) === "queue") {
      void props.onQueue();
      return;
    }
    void props.onSend();
  }, [props.busy, props.draft, props.attachments, props.onSend, props.onQueue, props.submissionDisabled, props.submissionPreparing]);

  // 编辑器只显示草稿的文本部分（剥离附件 token），每次变更再把当前附件 token
  // 追加回去，保证草稿这一附件生命周期真源不被破坏。
  const draftWithoutAttachments = props.draft.replace(ATTACHMENT_TOKEN_RE, "");
  const handleEditorDraftChange = useCallback((text: string) => {
    const stripped = text.replace(ATTACHMENT_TOKEN_RE, "");
    const tokens = props.attachments.map((attachment) => `[attachment ${attachment.id}]`).join("");
    props.onDraftChange(`${stripped}${tokens}`);
  }, [props.onDraftChange, props.attachments]);

  const slashCommandQuery = getSlashCommandQuery(props.draft);
  const slashOpenNext = slashCommandQuery !== null;
  const slashQuery = slashCommandQuery ?? "";
  const mentionMatch = props.draft.match(/@([^\s@]*)$/);
  const mentionOpenNext = Boolean(mentionMatch);
  const mentionQuery = mentionMatch?.[1] ?? "";
  const plusMenuAgents = useMemo(
    () => agents.filter((agent) => isNonDefaultAgent(agent) && agent.name.trim().toLowerCase() !== "build"),
    [agents],
  );

  // 统一加号菜单：「添加 / 插件 / MCP」三组都在同一层展示。
  // 默认智能体和 OpenCode 内置 Build 不作为显式选项展示。
  const plusMenuAgentEntries = useMemo(() =>
    plusMenuAgents.map((agent) => {
      const normalizedName = agent.name.trim().toLowerCase();
      return {
        name: agent.name as string | null,
        label: normalizedName === "plan"
          ? t("composer.agent_plan_mode")
          : agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
        description: normalizedName === "plan"
          ? t("composer.plus_menu_plan_description")
          : agent.description?.trim() || t("composer.plus_menu_agent_description"),
      };
    }), [plusMenuAgents]);

  const composerExtensions = JUGGLEWORK_EXTENSION_CATALOG.filter((entry) =>
    !builtInExtensionsDisabled &&
    !isJuggleWorkExtensionHidden(entry) && isComposerExtensionAvailable(entry)
  );
  const activeMcpItems = mcpServers.map((entry) => ({
    entry,
    status: toReactMcpStatus(entry.id ?? entry.name, entry, mcpStatuses),
    detail: mcpStatuses[entry.id ?? entry.name],
  }));

  const plusMenuAddEntries = useMemo<PlusMenuEntry[]>(() => [
    { kind: "file", id: "file", label: t("composer.plus_menu_file"), description: t("composer.plus_menu_file_description") },
    { kind: "sketch", id: "sketch", label: t("composer.plus_menu_draw"), description: t("composer.plus_menu_draw_description") },
    ...(props.imageGenerationModels.length > 0
      ? [{ kind: "image-generation" as const, id: "image-generation" as const, label: t("composer.image_generation"), description: t("composer.plus_menu_image_description") }]
      : []),
    ...(props.videoGenerationModels.length > 0
      ? [{ kind: "video-generation" as const, id: "video-generation" as const, label: t("composer.video_generation"), description: t("composer.plus_menu_video_description") }]
      : []),
    ...plusMenuAgentEntries.map((entry) => ({
      kind: "agent" as const,
      id: entry.name ? `agent:${entry.name}` : "agent:",
      label: entry.label,
      description: entry.description,
      name: entry.name,
    })),
  ], [plusMenuAgentEntries, props.imageGenerationModels.length, props.videoGenerationModels.length]);
  const plusMenuPluginEntries: PlusMenuEntry[] = [
    ...composerExtensions.map((extension) => ({
      kind: "extension" as const,
      id: `extension:${extension.id ?? extension.serverName ?? extension.name}`,
      label: extension.name,
      description: extension.description,
      extension,
    })),
    ...importedPlugins.flatMap((plugin) => plugin.files.map((file) => ({
      kind: "plugin-file" as const,
      id: `plugin-file:${plugin.pluginId}:${file.configObjectId}:${file.path}`,
      label: file.title,
      description: [plugin.name, formatPluginObjectType(file.objectType)].filter(Boolean).join(" · "),
      file,
    }))),
  ];
  const plusMenuMcpEntries: PlusMenuEntry[] = activeMcpItems.map(({ entry, status, detail }) => ({
    kind: "mcp" as const,
    id: `mcp:${entry.id ?? entry.name}`,
    label: entry.name,
    description: entry.origin === "jugglework-connect"
      ? [entry.marketplaceName, entry.pluginName].filter(Boolean).join(" · ") || entry.config.url || "Remote MCP"
      : entry.config.type === "remote"
        ? entry.config.url ?? entry.config.command?.join(" ") ?? "Remote MCP"
        : entry.config.command?.join(" ") ?? "Local MCP",
    entry,
    status,
    detail,
  }));
  const plusMenuEntries = [...plusMenuAddEntries, ...plusMenuPluginEntries, ...plusMenuMcpEntries];

  useEffect(() => {
    setSlashOpen(slashOpenNext);
    if (slashOpenNext) {
      setPlusMenuOpen(false);
    }
    setMenuIndex(0);
  }, [slashOpenNext, slashQuery]);

  useEffect(() => {
    setMentionOpen(mentionOpenNext);
    setMenuIndex(0);
  }, [mentionOpenNext, mentionQuery]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    void props.onRefreshImageGenerationModels();
    void props.onRefreshVideoGenerationModels();
    void props.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [plusMenuOpen, props.listAgents, props.onRefreshImageGenerationModels, props.onRefreshVideoGenerationModels]);

  useEffect(() => {
    let cancelled = false;
    void props.listAgents().then((next) => {
      if (!cancelled) setAgents(next);
    }).catch(() => {
      if (!cancelled) setAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, [props.listAgents]);

  useEffect(() => {
    setSkills(props.skills ?? []);
  }, [props.skills]);

  useEffect(() => {
    setMcpServers(props.mcpServers ?? []);
    setMcpStatuses(props.mcpStatuses ?? {});
  }, [props.mcpServers, props.mcpStatuses]);

  useEffect(() => {
    setImportedPlugins(props.importedPlugins ?? []);
  }, [props.importedPlugins]);

  useEffect(() => {
    listCommandsRef.current = props.listCommands;
  }, [props.listCommands]);

  useEffect(() => {
    listSkillsRef.current = props.listSkills;
  }, [props.listSkills]);

  useEffect(() => {
    listMcpRef.current = props.listMcp;
  }, [props.listMcp]);

  useEffect(() => {
    listImportedPluginsRef.current = props.listImportedPlugins;
  }, [props.listImportedPlugins]);

  useEffect(() => {
    setPlusMenuIndex(0);
  }, [plusMenuOpen]);

  useEffect(() => {
    plusItemRefs.current.length = plusMenuEntries.length;
    const target = plusItemRefs.current[plusMenuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [plusMenuIndex, plusMenuEntries.length]);

  useEffect(() => {
    commandsLoadVersionRef.current += 1;
    commandsCacheRef.current = null;
    commandsRequestRef.current = null;
  }, [props.listCommands]);

  const loadCommands = useCallback(() => {
    if (commandsCacheRef.current !== null) {
      return Promise.resolve(commandsCacheRef.current);
    }
    if (commandsRequestRef.current) {
      return commandsRequestRef.current;
    }
    const version = commandsLoadVersionRef.current;
    const request = listCommandsRef.current().then((next) => {
      if (commandsLoadVersionRef.current === version) {
        commandsCacheRef.current = next;
      }
      return next;
    }).finally(() => {
      if (commandsLoadVersionRef.current === version) {
        commandsRequestRef.current = null;
      }
    });
    commandsRequestRef.current = request;
    return request;
  }, []);

  const loadSkills = useCallback(() => {
    if (skillsRequestRef.current) return skillsRequestRef.current;
    const listSkills = listSkillsRef.current;
    if (!listSkills) return Promise.resolve([]);
    const request = listSkills().finally(() => {
      if (skillsRequestRef.current === request) skillsRequestRef.current = null;
    });
    skillsRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(JUGGLEWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(JUGGLEWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!slashOpen) return;
    let cancelled = false;
    const cached = commandsCacheRef.current;
    if (cached !== null) {
      setCommands(cached);
      setCommandsLoading(false);
      setCommandsLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    setCommandsLoading(true);
    void loadCommands()
      .then((next) => {
        if (!cancelled) {
          setCommands(next);
          setCommandsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommands([]);
          setCommandsLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, loadCommands]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    void Promise.all([props.listAgents(), props.searchFiles(mentionQuery), listRunningAppsForMention()]).then(([agentList, files, apps]) => {
      if (cancelled) return;
      const recent = props.recentFiles.slice(0, 8);
      const next: MentionItem[] = [
        ...agentList.map((agent) => ({ id: `agent:${agent.name}`, kind: "agent" as const, value: agent.name, label: agent.name })),
        ...recent.map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
        // Running macOS apps (Computer Use targets). Listed after recent files
        // so an empty "@" stays file-first; fuzzy search surfaces them as the
        // user types (e.g. "@mus" → Music).
        ...apps.map((appName) => ({ id: `app:${appName}`, kind: "app" as const, value: appName, label: appName })),
        ...files.filter((file) => !recent.includes(file)).map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
      ];
      setMentionItems(next);
    }).catch(() => {
      if (!cancelled) setMentionItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, mentionQuery, props.listAgents, props.recentFiles, props.searchFiles]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (plusMenuRef.current?.contains(target)) return;
      if (plusMenuPopupRef.current?.contains(target)) return;
      setPlusMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [plusMenuOpen]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const listImportedPlugins = listImportedPluginsRef.current;
    if (listImportedPlugins) {
      let cancelled = false;
      void listImportedPlugins()
        .then((next) => {
          if (!cancelled) setImportedPlugins(next);
        })
        .catch(() => {
          if (!cancelled) setImportedPlugins([]);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [plusMenuOpen]);

  useEffect(() => {
    if (slashOpen) {
      let cancelled = false;
      setSkillsLoading(true);
      void loadSkills()
        .then((next) => {
          if (!cancelled) setSkills(next);
        })
        .catch(() => {
          if (!cancelled) setSkills([]);
        })
        .finally(() => {
          if (!cancelled) setSkillsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [loadSkills, slashOpen]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const listMcp = listMcpRef.current;
    if (listMcp) {
      let cancelled = false;
      setMcpLoading(true);
      void listMcp()
        .then((next) => {
          if (cancelled) return;
          setMcpServers(next.servers);
          setMcpStatuses(next.statuses);
        })
        .catch(() => {
          if (cancelled) return;
          setMcpServers([]);
          setMcpStatuses({});
        })
        .finally(() => {
          if (!cancelled) setMcpLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [plusMenuOpen]);

  const toolCommandItems = commands.filter((command) => !command.source || command.source === "command");
  const toolSkillItems = commands.filter((command) => command.source === "skill");
  const localCommandSkillNames = new Set(toolSkillItems.map((command) => command.name));
  const skillMenuItems: SkillCard[] = [
    ...toolSkillItems.map((command) => ({
      name: command.name,
      path: `command://${command.id}`,
      description: command.description,
      origin: "local" as const,
    })),
    ...skills.filter((skill) =>
      skill.origin === "jugglework-connect" || !localCommandSkillNames.has(skill.name)
    ),
  ];
  const slashSkillItems = useMemo<ComposerSlashCommandOption[]>(() => [
    ...skillMenuItems.map((skill) => ({
      id: `skill:${skill.origin ?? "local"}:${skill.path || skill.name}`,
      name: skillMenuSlashCommandName(skill),
      description: skill.description,
      source: "skill" as const,
      origin: skill.origin,
      marketplaceName: skill.marketplaceName,
      pluginName: skill.pluginName,
      connectCapabilityName: skill.connectCapabilityName,
      skill,
    })),
    ...connectSkillSlashCommandOptions(skills).filter((candidate) =>
      !skillMenuItems.some((skill) => skill.name === candidate.skill?.name && skill.origin === candidate.skill?.origin)
    ),
  ], [skillMenuItems, skills]);
  const filterSlashItems = useCallback((items: ComposerSlashCommandOption[]) => {
    if (!slashQuery) return items;
    return fuzzysort.go(slashQuery, items, { keys: ["name", "description"], limit: 40 }).map((entry) => entry.obj);
  }, [slashQuery]);
  const slashCommandFiltered = useMemo(
    () => slashOpen ? filterSlashItems(toolCommandItems) : [],
    [filterSlashItems, slashOpen, toolCommandItems],
  );
  const slashSkillFiltered = useMemo(
    () => slashOpen ? filterSlashItems(slashSkillItems) : [],
    [filterSlashItems, slashOpen, slashSkillItems],
  );
  const slashFiltered = useMemo(
    () => [...slashCommandFiltered, ...slashSkillFiltered],
    [slashCommandFiltered, slashSkillFiltered],
  );
  const mentionFiltered = useMemo(() => {
    if (!mentionOpen) return [];
    if (!mentionQuery) return mentionItems.slice(0, 8);
    return fuzzysort.go(mentionQuery, mentionItems, { keys: ["label"], limit: 8 }).map((entry) => entry.obj);
  }, [mentionItems, mentionOpen, mentionQuery]);
  const pastedTextTokens = useMemo(
    () => props.pastedText.map((item) => ({ label: item.label, lines: item.lines, text: item.text })),
    [props.pastedText],
  );

  const handleExpandPastedText = useCallback((label: string) => {
    const target = props.pastedText.find((item) => item.label === label);
    if (!target) return;
    props.onExpandPastedText(target.id);
  }, [props.onExpandPastedText, props.pastedText]);

  const activeMenu = slashOpen ? "slash" : mentionOpen ? "mention" : null;
  const activeItems = activeMenu === "slash" ? slashFiltered : activeMenu === "mention" ? mentionFiltered : [];
  const canSend = props.draft.trim().length > 0 || props.attachments.length > 0;

  useEffect(() => {
    if (!activeItems.length) {
      setMenuIndex(0);
      return;
    }
    setMenuIndex((current) => Math.max(0, Math.min(current, activeItems.length - 1)));
  }, [activeItems.length]);

  useEffect(() => {
    menuItemRefs.current.length = activeItems.length;
    const target = menuItemRefs.current[menuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [menuIndex, activeItems.length]);

  const applyCommandSelection = (command: ComposerSlashCommandOption, options?: { replaceSkillDraft?: boolean }) => {
    if (command.origin === "jugglework-connect" && command.connectCapabilityName) {
      const prompt = t("composer.connect_command_prompt", {
        name: command.name,
        marketplace: command.marketplaceName ?? "assigned",
        capability: command.connectCapabilityName,
      });
      const separator = props.draft.length > 0 && !/\s$/.test(props.draft) ? " " : "";
      props.onDraftChange(options?.replaceSkillDraft ? prompt : `${props.draft}${separator}${prompt}`);
      setSlashOpen(false);
      setPlusMenuOpen(false);
      return;
    }
    if (command.skill) {
      applySkillSelection(command.skill, options);
      return;
    }
    if (command.source === "skill") {
      applySkillSelection(command.name, options);
      return;
    }
    props.onDraftChange(`/${command.name} `);
    setSlashOpen(false);
    setPlusMenuOpen(false);
  };

  /**
   * 把一项能力作为 tag 插入草稿，并登记它送给模型时要展开成什么
   *
   * TIPS: 草稿里只留紧凑 token，展开文案交给 session-surface 的 buildDraft。
   * 过去云端能力是直接把整段指令散文写进输入框，用户看到的是一堆半截文本。
   * @param kind 能力种类
   * @param name 能力名称，即 tag 内显示的文本
   * @param prompt 送给模型的完整表述
   * @param options replaceSkillDraft 表示替换整段草稿（斜杠命令补全路径）
   */
  const insertCapabilityTag = (
    kind: ComposerCapabilityKind,
    name: string,
    prompt: string,
    options?: { replaceSkillDraft?: boolean },
  ) => {
    props.onRegisterCapability?.({ kind, name, prompt });
    const token = composerCapabilityToken(kind, name);
    if (options?.replaceSkillDraft) {
      props.onDraftChange(`${token} `);
    } else {
      const editor = editorRef.current;
      if (editor) {
        editor.insertSkillAtSelection(name, kind);
      } else {
        const separator = props.draft.length > 0 && !/\s$/.test(props.draft) ? " " : "";
        props.onDraftChange(`${props.draft}${separator}${token} `);
      }
    }
    setSlashOpen(false);
    setPlusMenuOpen(false);
  };

  const applySkillSelection = (input: string | SkillCard, options?: { replaceSkillDraft?: boolean }) => {
    const skill = typeof input === "string"
      ? { name: input, path: "", origin: "local" as const }
      : input;
    if (skill.origin === "jugglework-connect") {
      // 未安装的技能要先经 Cloud MCP 取回内容，细节放进括号，整句仍可折叠成 tag。
      insertCapabilityTag(
        "cloud-skill",
        skill.name,
        buildCapabilityInstruction(
          "cloud-skill",
          skill.name,
          `find it with jugglework-cloud_search_capabilities in the ${skill.marketplaceName ?? "assigned"} marketplace, `
          + `then call jugglework-cloud_execute_capability with the exact capability name ${skill.connectCapabilityName ?? skill.name}`,
        ),
        options,
      );
      return;
    }
    insertCapabilityTag("skill", skill.name, buildCapabilityInstruction("skill", skill.name), options);
  };

  const applyPluginFileSelection = (file: CloudImportedPluginFile) => {
    const commandName = pluginSlashCommandName(file);
    if (commandName) {
      if (file.objectType === "skill") applySkillSelection(commandName);
      else applyCommandSelection({
        id: `plugin:${file.configObjectId}`,
        name: commandName,
        source: "command",
      });
      return;
    }
    props.onInsertMention("file", file.path);
    setPlusMenuOpen(false);
  };

  const applyExtensionSelection = (entry: McpDirectoryInfo) => {
    // TIPS: 目录里的 composerPrompt（如 "Use Computer Use to "）是给草稿起手用的半截文案，
    // 不能直接当指令发送，这里统一改用能力指令模板。
    insertCapabilityTag("extension", entry.name, buildCapabilityInstruction("extension", entry.name));
  };

  /**
   * 选择一个 MCP 服务
   * @param entry MCP 服务条目
   * @param status 归一化后的连接状态，仅 connected 可选
   */
  const applyMcpSelection = (entry: McpServerEntry, status: McpServerStatus) => {
    if (status !== "connected") return;
    const selection = resolveMcpCapabilitySelection(entry);
    insertCapabilityTag(selection.kind, entry.name, selection.prompt);
  };

  // 普通函数（非 useCallback）：需要始终读取当前渲染的 fileInput 绑定。
  const activatePlusEntry = (entry: PlusMenuEntry) => {
    if (entry.kind === "file") {
      if (!props.attachmentsEnabled) {
        toast.warning(props.attachmentsDisabledReason ?? t("composer.attachments_unavailable"));
        return;
      }
      setPlusMenuOpen(false);
      fileInput?.click();
      return;
    }
    if (entry.kind === "sketch") {
      if (!props.attachmentsEnabled) {
        toast.warning(props.attachmentsDisabledReason ?? t("composer.attachments_unavailable"));
        return;
      }
      setPlusMenuOpen(false);
      setSketchOpen(true);
      return;
    }
    if (entry.kind === "image-generation") {
      if (props.imageGenerationLoading || props.imageGenerationModels.length === 0) return;
      setPlusMenuOpen(false);
      props.onEnableImageGeneration();
      return;
    }
    if (entry.kind === "video-generation") {
      if (props.videoGenerationLoading || props.videoGenerationModels.length === 0) return;
      setPlusMenuOpen(false);
      props.onEnableVideoGeneration();
      return;
    }
    if (entry.kind === "agent") {
      if (props.busy) return;
      props.onSelectAgent(entry.name);
      setPlusMenuOpen(false);
      return;
    }
    if (entry.kind === "extension") {
      applyExtensionSelection(entry.extension);
      return;
    }
    if (entry.kind === "plugin-file") {
      applyPluginFileSelection(entry.file);
      return;
    }
    applyMcpSelection(entry.entry, entry.status);
  };

  const acceptActiveItem = () => {
    if (!activeItems.length) return false;
    if (activeMenu === "slash") {
      const command = slashFiltered[menuIndex];
      if (!command) return false;
      applyCommandSelection(command, { replaceSkillDraft: true });
      return true;
    }
    if (activeMenu === "mention") {
      const item = mentionFiltered[menuIndex];
      if (!item) return false;
      props.onInsertMention(item.kind, item.value);
      setMentionOpen(false);
      return true;
    }
    return false;
  };

  // Focus requests are scoped to one session and remain pending until that
  // composer's editor is mounted and editable. This avoids the old global
  // broadcast behavior where every mounted split/retained composer focused
  // itself and fixed-delay retries could steal focus from newer user input.
  useEffect(() => {
    const handleFocus = () => {
      const request = getPendingComposerFocusRequest();
      if (!request || request.sessionId !== props.sessionId) return;
      if (!props.focusEligible || props.disabled) return;
      const root = rootRef.current;
      if (!root) return;
      const editable = root.querySelector<HTMLElement>("[contenteditable='true']");
      if (!editable || !editable.isConnected || editable.getClientRects().length === 0) return;
      editable.focus({ preventScroll: true });
      if (document.activeElement === editable) {
        completeComposerFocusRequest(request.id, props.sessionId);
      }
    };
    window.addEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocus);
    handleFocus();
    return () => window.removeEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocus);
  }, [props.disabled, props.focusEligible, props.sessionId]);

  // Listen for draft flush events. The shell uses these from the browser
  // pagehide/beforeunload cycle so no in-flight draft is lost.
  useEffect(() => {
    const handleFlush = () => {
      // onDraftChange always runs synchronously on every keystroke, so this
      // listener is effectively a hook for the shell to signal "we're about
      // to unmount, commit any debounced state". Re-fire with the current
      // draft so downstream stores can checkpoint it.
      props.onDraftChange(draftRef.current);
    };
    window.addEventListener(FLUSH_PROMPT_EVENT, handleFlush);
    window.addEventListener("beforeunload", handleFlush);
    window.addEventListener("pagehide", handleFlush);
    return () => {
      window.removeEventListener(FLUSH_PROMPT_EVENT, handleFlush);
      window.removeEventListener("beforeunload", handleFlush);
      window.removeEventListener("pagehide", handleFlush);
    };
  }, [props.onDraftChange]);

  const handleKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    // IME composition guard — block Enter while IME is mid-character.
    const imeActive =
      imeComposingRef.current ||
      (event.nativeEvent as KeyboardEvent).isComposing === true ||
      event.keyCode === 229;
    if (event.key === "Enter" && imeActive) {
      return;
    }
    // macOS Option+Enter / Windows Alt+Enter inserts a newline. Let the
    // editor handle it before any open command or mention menu consumes it.
    if (event.key === "Enter" && event.altKey) {
      return;
    }
    // Escape-to-stop while the agent is busy. Only when no menu is open so
    // Escape can still close menus. First press arms a confirmation prompt
    // for 3s; a second Escape within that window stops the agent.
    const anyMenuOpen = plusMenuOpen || Boolean(activeMenu);
    if (event.key === "Escape" && props.busy && !anyMenuOpen) {
      event.preventDefault();
      if (escapeArmed) {
        disarmEscape();
        void props.onStop();
      } else {
        setEscapeArmed(true);
        if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = setTimeout(() => {
          setEscapeArmed(false);
          escapeTimerRef.current = null;
        }, 3000);
      }
      return;
    }

    if (plusMenuOpen) {
      const total = plusMenuEntries.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPlusMenuIndex((current) => (current + 1) % total);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPlusMenuIndex((current) => (current - 1 + total) % total);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const entry = plusMenuEntries[plusMenuIndex];
        if (entry) activatePlusEntry(entry);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPlusMenuOpen(false);
        return;
      }
    }

    // Input history recall (#2012). Only when no menu is consuming the
    // arrow keys and IME composition is not active.
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !imeActive &&
      !plusMenuOpen &&
      (!activeMenu || !activeItems.length)
    ) {
      const history = props.inputHistory ?? [];
      const position = historyPosRef.current;
      if (event.key === "ArrowUp") {
        const startRecall = position === null && props.draft.trim() === "" && history.length > 0;
        const continueRecall = position !== null && position > 0;
        if (startRecall || continueRecall) {
          const nextPos = position === null ? history.length - 1 : position - 1;
          if (position === null) historyStashRef.current = props.draft;
          historyPosRef.current = nextPos;
          historyExpectedRef.current = history[nextPos];
          event.preventDefault();
          props.onDraftChange(history[nextPos]);
          return;
        }
      } else if (position !== null) {
        event.preventDefault();
        const nextPos = position + 1;
        if (nextPos >= history.length) {
          historyPosRef.current = null;
          historyExpectedRef.current = null;
          props.onDraftChange(historyStashRef.current);
        } else {
          historyPosRef.current = nextPos;
          historyExpectedRef.current = history[nextPos];
          props.onDraftChange(history[nextPos]);
        }
        return;
      }
    }

    if (!activeMenu || !activeItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex((current) => (current + 1) % activeItems.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex((current) => (current - 1 + activeItems.length) % activeItems.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      void acceptActiveItem();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSlashOpen(false);
      setMentionOpen(false);
    }
  };

  const addAttachments = async (inputFiles: File[]) => {
    if (!inputFiles.length) return false;
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? t("composer.attachments_unavailable"));
      return false;
    }

    const accepted: File[] = [];
    const oversize: string[] = [];

    for (const original of inputFiles) {
      const processed = original.type.startsWith("image/") ? await compressImageFile(original) : original;
      if (processed.size > MAX_ATTACHMENT_BYTES) {
        oversize.push(processed.name || original.name);
        continue;
      }
      accepted.push(processed);
    }

    if (accepted.length) {
      props.onAttachFiles(accepted);
    }

    if (oversize.length) {
      toast.warning(
        oversize.length === 1
          ? t("composer.file_exceeds_limit", { name: oversize[0] })
          : `${oversize.length} files exceed the 8MB limit.`,
      );
    }
    return accepted.length === inputFiles.length;
  };

  const panelRoundedClass =
    mentionOpen
      ? "rounded-t-[18px] border-t-transparent"
      : "";

  const renderPlusMenu = () => {
    if (!plusMenuOpen) return null;
    const groups = [
      { id: "add", label: t("composer.plus_menu_section_add"), entries: plusMenuAddEntries },
      { id: "plugins", label: t("composer.plus_menu_section_plugins"), entries: plusMenuPluginEntries },
      { id: "mcp", label: t("composer.plus_menu_section_mcp"), entries: plusMenuMcpEntries },
    ];
    let flatIndex = 0;

    return (
      <div
        ref={plusMenuPopupRef}
        className="absolute bottom-[calc(100%+8px)] left-[-1px] right-[-1px] z-40 overflow-hidden rounded-[22px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]"
      >
        <div
          role="menu"
          aria-label={t("composer.plus_label")}
          className="subtle-scrollbar max-h-[min(30rem,calc(100vh-12rem))] overflow-x-hidden overflow-y-auto p-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          {groups.map((group, groupIndex) => (
            <section key={group.id} className={groupIndex > 0 ? "mt-1" : undefined}>
              <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-gray-9">
                {group.label}
              </div>
              <div className="grid gap-0">
                {group.entries.map((entry) => {
                  const index = flatIndex++;
                  const attachmentAction = entry.kind === "file" || entry.kind === "sketch";
                  const unavailableMcp = entry.kind === "mcp" && (entry.status !== "connected" || entry.entry.workspaceEnabled === false);
                  const disabled = unavailableMcp || (
                    entry.kind === "image-generation" || entry.kind === "video-generation"
                      ? false
                      : attachmentAction
                        ? !props.attachmentsEnabled
                        : entry.kind === "agent" && props.busy
                  );
                  const selected = entry.kind === "agent"
                    ? entry.name === null ? !props.selectedAgent : props.selectedAgent === entry.name
                    : entry.kind === "image-generation"
                      ? Boolean(props.imageGeneration)
                      : entry.kind === "video-generation" && Boolean(props.videoGeneration);
                  const disabledTitle = attachmentAction && disabled
                    ? props.attachmentsDisabledReason ?? t("composer.attachments_unavailable")
                    : entry.kind === "mcp" && disabled
                      ? entry.entry.workspaceEnabled === false
                        ? t("connect.workspace_disabled_here")
                        : mcpStatusTooltip(entry.status, entry.detail)
                      : undefined;
                  return (
                    <button
                      key={entry.id}
                      ref={(element) => {
                        plusItemRefs.current[index] = element;
                      }}
                      type="button"
                      role="menuitem"
                      disabled={disabled}
                      title={disabledTitle ?? entry.description}
                      className={`flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-[13px] px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gray-7 ${selected || plusMenuIndex === index ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2/80"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                      onMouseEnter={() => setPlusMenuIndex(index)}
                      onClick={() => activatePlusEntry(entry)}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-gray-10">
                        {entry.kind === "file" ? <Paperclip size={18} strokeWidth={1.8} /> : null}
                        {entry.kind === "sketch" ? <PenLine size={18} strokeWidth={1.8} /> : null}
                        {entry.kind === "image-generation" ? <ImagePlus size={18} strokeWidth={1.8} /> : null}
                        {entry.kind === "video-generation" ? <SquarePlay size={18} strokeWidth={1.8} /> : null}
                        {entry.kind === "agent" ? plusMenuAgentIcon(entry.name) : null}
                        {entry.kind === "extension" ? extensionIcon(entry.extension, 18) : null}
                        {entry.kind === "plugin-file" ? <FileText size={18} strokeWidth={1.8} /> : null}
                        {entry.kind === "mcp" ? <Plug size={18} strokeWidth={1.8} /> : null}
                      </span>
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="shrink-0 text-[13px] font-medium text-gray-12">{entry.label}</span>
                        <span className="min-w-0 truncate text-[13px] text-gray-9">{entry.description}</span>
                      </span>
                      {selected ? <Check size={16} className="shrink-0 text-gray-10" /> : null}
                      {entry.kind === "mcp" ? (
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${mcpStatusBadgeClass(entry.status)}`}>
                          {entry.entry.workspaceEnabled === false ? t("connect.workspace_disabled_here") : formatMcpStatusLabel(entry.status)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {group.entries.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-[13px] text-gray-9">
                    {group.id === "mcp" && mcpLoading
                      ? t("composer.plus_menu_loading_mcp")
                      : group.id === "mcp"
                        ? t("composer.plus_menu_no_mcp")
                        : t("composer.plus_menu_no_plugins")}
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  };

  const renderSlashMenu = () => {
    if (!slashOpen) return null;
    const groups = [
      { id: "commands", label: t("composer.slash_section_commands"), entries: slashCommandFiltered },
      { id: "skills", label: t("composer.slash_section_skills"), entries: slashSkillFiltered },
    ].filter((group) => group.entries.length > 0);
    let flatIndex = 0;
    return (
      <div className="absolute bottom-[calc(100%+8px)] left-[-1px] right-[-1px] z-30 overflow-hidden rounded-[22px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div
          role="menu"
          aria-label={t("composer.slash_menu_label")}
          className="subtle-scrollbar max-h-[min(30rem,calc(100vh-12rem))] overflow-x-hidden overflow-y-auto p-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          {groups.length > 0 ? groups.map((group, groupIndex) => (
            <section key={group.id} className={groupIndex > 0 ? "mt-1" : undefined}>
              <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-gray-9">{group.label}</div>
              <div className="grid gap-0">
                {group.entries.map((command) => {
                  const index = flatIndex++;
                  const isSkill = group.id === "skills";
                  const scope = command.skill?.scope === "global"
                    ? t("composer.scope_personal")
                    : command.skill?.scope === "project"
                      ? t("composer.scope_workspace")
                      : command.origin === "jugglework-connect"
                        ? t("composer.source_cloud")
                        : null;
                  return (
                    <button
                      key={command.id}
                      ref={(element) => {
                        menuItemRefs.current[index] = element;
                      }}
                      type="button"
                      role="menuitem"
                      className={`flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-[13px] px-1.5 py-1 text-left outline-none transition-colors hover:bg-gray-2/70 focus-visible:ring-2 focus-visible:ring-gray-7 ${activeMenu === "slash" && slashFiltered[menuIndex]?.id === command.id ? "bg-gray-3 text-gray-12" : "text-gray-11"}`}
                      onMouseEnter={() => setMenuIndex(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        applyCommandSelection(command, { replaceSkillDraft: true });
                      }}
                      onClick={(event) => {
                        if (event.detail === 0) applyCommandSelection(command, { replaceSkillDraft: true });
                      }}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-gray-10">
                        {slashCommandIcon(command, isSkill)}
                      </span>
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="shrink-0 text-[13px] font-medium text-gray-12">
                          {slashCommandLabel(command, isSkill)}
                        </span>
                        <span className="min-w-0 truncate text-[13px] text-gray-9">
                          {slashCommandDescription(command, isSkill)}
                        </span>
                      </span>
                      {scope ? <span className="shrink-0 text-[11px] text-gray-9">{scope}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          )) : (
            <div className="px-2.5 py-1.5 text-[13px] text-gray-10">
              {(!commandsLoaded && commandsLoading) || skillsLoading ? t("composer.loading_commands") : t("composer.no_commands")}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMentionMenu = () => {
    if (!mentionOpen || mentionFiltered.length === 0) return null;
    return (
      <div className="absolute bottom-full left-[-1px] right-[-1px] z-30">
          <div className="overflow-hidden rounded-t-[20px] border border-dls-border border-b-0 bg-dls-surface shadow-[var(--dls-shell-shadow)]">
            <div
              role="presentation"
              className="max-h-64 overflow-y-auto p-2"
              onMouseDown={(event) => event.preventDefault()}
          >
            <div className="grid gap-1">
              {mentionFiltered.map((item, index) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    menuItemRefs.current[index] = element;
                  }}
                  type="button"
                  className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${activeMenu === "mention" && mentionFiltered[menuIndex]?.id === item.id ? "bg-gray-3 text-gray-12" : "text-gray-11"}`}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => {
                    props.onInsertMention(item.kind, item.value);
                    setMentionOpen(false);
                  }}
                >
                  {item.kind === "agent" ? (
                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : item.kind === "app" ? (
                    <AppWindowMac size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : (
                    <FileText size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">@{item.label}</div>
                    <div className="truncate text-xs text-gray-10">
                      {item.kind === "agent"
                        ? t("composer.agent_label")
                        : item.kind === "app"
                          ? t("composer.app_kind")
                          : t("composer.file_kind")}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`sticky bottom-0 ${plusMenuOpen || slashOpen ? "z-50" : "z-20"} bg-gradient-to-t from-dls-surface via-dls-surface/95 to-transparent px-4 pb-2 md:px-8`}
      style={{ contain: "layout style" }}
      onKeyDownCapture={handleKeyDownCapture}
      onCompositionStart={() => {
        imeComposingRef.current = true;
      }}
      onCompositionEnd={() => {
        imeComposingRef.current = false;
      }}
    >
      <div className="max-w-[800px] mx-auto">
        {/* Main composer panel */}
        <div
          className={`relative overflow-visible rounded-[24px] border border-dls-border bg-dls-surface shadow-[0_10px_30px_rgba(15,23,42,0.1)] transition-[border-color,box-shadow] dark:shadow-[0_14px_36px_rgba(0,0,0,0.3)] ${panelRoundedClass}`}
        >
          {props.topAccessory ? <div className="relative z-10">{props.topAccessory}</div> : null}

          {renderPlusMenu()}
          {renderMentionMenu()}
          {renderSlashMenu()}

          {/*
            The pasted-text chip used to render twice — once inline inside
            the Lexical editor (via ComposerPastedTextNode) and again as a
            separate rail here above the composer. Keep only the inline
            chip; its pill already shows label + line count, and the user
            removes it with backspace like any other inline token.
          */}

          {dropzoneActive ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-[20px] border-2 border-dashed border-dls-accent bg-[color:color-mix(in_oklab,var(--dls-accent)_10%,transparent)]">
              <div className="rounded-2xl border border-dls-border bg-dls-surface/95 px-5 py-4 text-center backdrop-blur-sm">
                <div className="text-sm font-medium text-dls-text">{t("composer.attach_files")}</div>
                <div className="mt-1 text-xs text-dls-secondary">{t("composer.any_file_type_supported")}</div>
              </div>
            </div>
          ) : null}

          <div className="px-4 pt-3 pb-2">
            {props.imageGeneration ? (
              <ImageGenerationControls
                models={props.imageGenerationModels}
                value={props.imageGeneration}
                disabled={props.imageGenerationLoading}
                onChange={props.onImageGenerationChange}
                onClose={props.onDisableImageGeneration}
              />
            ) : null}
            {props.videoGeneration ? (
              <VideoGenerationControls
                models={props.videoGenerationModels}
                value={props.videoGeneration}
                disabled={props.videoGenerationLoading}
                onChange={props.onVideoGenerationChange}
                onClose={props.onDisableVideoGeneration}
              />
            ) : null}

            {/* 附件行：文件独占区域，位于输入框上方，可横向滚动。 */}
            {props.attachments.length > 0 ? (
              <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                {props.attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group relative flex shrink-0 items-center"
                    title={attachment.name}
                  >
                    {isImageAttachment(attachment) && attachment.previewUrl ? (
                      // TIPS: 图片附件复用会话页的 ImageAttachmentBadge：点击缩略图
                      // 打开灯箱预览（与消息区行为一致），移除按钮由组件内置。
                      // thumbnailClassName 维持输入栏原有 14×14 规格（组件默认 10×10）。
                      <ImageAttachmentBadge
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        thumbnailClassName="h-14 w-14"
                        onRemove={() => props.onRemoveAttachment(attachment.id)}
                      />
                    ) : (
                      <div className="relative flex w-[220px] max-w-[220px] items-center gap-2 rounded-xl border border-border/70 bg-muted/40 py-1.5 pl-2.5 pr-7">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
                          <FileText size={18} />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                            {attachment.name}
                          </span>
                          <span className="truncate text-[11px] font-medium uppercase leading-tight text-muted-foreground">
                            {attachmentTypeLabel(attachment.name)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={`Remove ${attachment.name}`}
                          title="Remove"
                          onClick={() => props.onRemoveAttachment(attachment.id)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            {/* Editor */}
            <LexicalPromptEditor
              ref={editorRef}
              value={draftWithoutAttachments}
              mentions={props.mentions}
              pastedText={pastedTextTokens}
              disabled={props.disabled}
              placeholder={props.videoGeneration
                ? t("composer.video_generation_placeholder")
                : props.imageGeneration
                  ? t("composer.image_generation_placeholder")
                  : t("composer.placeholder")}
              onChange={handleEditorDraftChange}
              onSubmit={handleEditorSubmit}
              onExpandPastedText={handleExpandPastedText}
              onRemoveAttachment={props.onRemoveAttachment}
              onPasteText={props.onPasteText}
              onPaste={(event) => {
                // Paste policy:
                // 1. Actual files on the clipboard -> attach them.
                // 2. Explicit text/uri-list (drag from Finder / browser) -> insert links.
                // 3. Plain text -> DO NOTHING. Let Lexical's PlainTextPlugin
                //    handle the paste natively so newlines render correctly
                //    and no content is silently dropped. Previous behavior
                //    hijacked pastes that merely contained absolute paths
                //    like "/Users/..." or pastes longer than 10 lines, which
                //    was the root cause of "paste into composer is broken".
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length) {
                  event.preventDefault();
                  void addAttachments(files);
                  return;
                }

                const uriList = event.clipboardData
                  ? parseClipboardUriList(event.clipboardData)
                  : [];
                if (uriList.length) {
                  event.preventDefault();
                  props.onUnsupportedFileLinks(uriList);
                  return;
                }

                const text = event.clipboardData?.getData("text/plain") ?? "";

                // Plain text paste display is owned by PasteChipPlugin inside
                // the Lexical editor: >50 chars collapse unless the whole
                // string is a standalone HTTP(S) URL; expanded pasted text gets
                // the gray pasted-content styling. Do NOT duplicate that here.

                if (
                  text.trim() &&
                  (props.isRemoteWorkspace || props.isSandboxWorkspace) &&
                  /file:\/\/|(^|\s)\/(Users|home|var|etc|opt|tmp|private|Volumes|Applications)\//.test(text)
                ) {
                  const attachedFiles = props.attachments.map((attachment) => attachment.file);
                  toast.warning(t("composer.remote_worker_paste_warning"), {
                    action:
                      props.onUploadInboxFiles && attachedFiles.length > 0
                        ? {
                            label: t("composer.upload_to_shared_folder"),
                            onClick: () => void props.onUploadInboxFiles?.(attachedFiles),
                          }
                        : undefined,
                  });
                  // Intentionally no preventDefault — the notice is advisory,
                  // the paste still goes through the editor.
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer?.files?.length) {
                  event.preventDefault();
                  if (!dropzoneActive) setDropzoneActive(true);
                }
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                setDropzoneActive(false);
              }}
              onDrop={(event) => {
                const files = Array.from(event.dataTransfer?.files ?? []);
                setDropzoneActive(false);
                if (!files.length) return;
                event.preventDefault();
                void addAttachments(files);
              }}
            />

            {/* Action row — add menu, model controls, and send */}
            <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <input
                  ref={(element) => {
                    fileInput = element ?? undefined;
                  }}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    if (files.length) void addAttachments(files);
                    event.currentTarget.value = "";
                  }}
                />
                {/* Unified add button: one entry point for files, agents, and
                    the tool menu (commands / skills / extensions / MCPs). */}
                <div
                  ref={plusMenuRef}
                  className="relative"
                  onMouseDown={(event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest("button")) event.preventDefault();
                  }}
                >
                  <button
                    type="button"
                    className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-md transition-colors ${plusMenuOpen ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-3"}`}
                    onClick={() => {
                      setMentionOpen(false);
                      setMentionItems([]);
                      setSlashOpen(false);
                      setPlusMenuOpen((value) => !value);
                    }}
                    aria-expanded={plusMenuOpen}
                    aria-haspopup="menu"
                    title={t("composer.plus_label")}
                  >
                    <Plus size={16} />
                  </button>
                </div>

                {/* Agent selection moved into the unified add menu above; the
                    same selection is still reachable from the command palette
                    ("Switch agent") and @agent mentions. */}

                {/* 权限模式（请求审批/完全访问）放在模型选择左侧。 */}
                {props.permissionModeSelector}

                <div className="flex items-center gap-0">
                  <ModelSelect
                    open={props.modelPickerOpen}
                    value={props.selectedModel}
                    onOpenChange={props.onModelPickerOpenChange}
                    onChange={(model) => {
                      if (!props.steering) props.onModelChange(model);
                    }}
                    disabled={props.steering}
                  />

                  <ContextUsage
                    messages={props.contextUsageMessages}
                    transcript={props.contextUsageTranscript}
                    model={props.selectedModel}
                    contextLimit={props.contextWindowTokens}
                    streaming={props.busy}
                  />
                </div>
                {props.modelUnavailable ? (
                  <span className="text-xs font-medium text-red-10">Model no longer available</span>
                ) : null}

                <ModelBehaviorSelect
                  value={props.modelVariant}
                  label={props.modelVariantLabel}
                  options={props.modelBehaviorOptions}
                  onChange={(value) => {
                    if (!props.steering) props.onModelVariantChange(value);
                  }}
                  disabled={props.steering}
                />
              </div>

              {/*
                Action area (icon-only):
                - Idle: a circular send button (Enter or click sends).
                - Busy: a circular stop button. Every follow-up submit joins
                  the FIFO queue via Enter; the queued count surfaces as a
                  badge on the stop button. Escape arms a "Hit Escape again
                  to stop the agent" prompt.
              */}
              <div className="ml-auto flex shrink-0 items-end gap-1.5">
                <Tooltip>
                  <TooltipTrigger render={<span className={`inline-flex ${voiceServiceDisabled ? "cursor-not-allowed" : ""}`} />}>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={toggleVoiceDictation}
                      disabled={voiceDictation.phase === "transcribing" || voiceServiceDisabled}
                      aria-pressed={voiceDictation.phase === "recording"}
                      aria-label={voiceButtonLabel}
                      className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-full transition-colors active:scale-[0.98] disabled:pointer-events-none ${
                        voiceServiceDisabled
                          ? "text-gray-7 opacity-70"
                          : voiceDictation.phase === "recording"
                            ? "bg-red-3 text-red-10 motion-safe:animate-pulse"
                            : "text-gray-11 hover:bg-gray-3 hover:text-gray-12"
                      }`}
                    >
                      {voiceDictation.phase === "requesting-permission" ||
                      voiceDictation.phase === "connecting" ||
                      voiceDictation.phase === "transcribing" ? (
                        <LoaderCircle size={17} className="animate-spin" />
                      ) : (
                        <Mic size={18} strokeWidth={1.9} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{voiceButtonLabel}</TooltipContent>
                </Tooltip>
                {props.busy ? (
                  <>
                    {escapeArmed ? (
                      <span className="self-center pr-1 text-[12px] font-medium text-gray-10">
                        {t("composer.escape_to_stop")}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={props.onStop}
                      className="relative inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-full bg-black text-white transition-colors hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
                      title={props.queuedCount > 0 ? t("composer.queued_count", { count: props.queuedCount }) : t("composer.stop")}
                    >
                      <Square size={12} fill="currentColor" />
                      {props.queuedCount > 0 ? (
                        <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--dls-accent)] px-1 text-[9px] font-semibold tabular-nums text-[var(--dls-accent-fg)]">
                          {props.queuedCount}
                        </span>
                      ) : null}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={canSend && !props.submissionDisabled && !props.submissionPreparing ? props.onSend : undefined}
                    disabled={props.disabled || props.submissionDisabled || !canSend || props.submissionPreparing}
                    className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-full transition-colors active:scale-[0.98] ${
                      !canSend || props.disabled || props.submissionDisabled || props.submissionPreparing
                        ? "bg-gray-4 text-gray-10"
                        : "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
                    }`}
                    title={props.submissionPreparingLabel ?? t("composer.run_task")}
                  >
                    {props.submissionPreparing ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={15} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {sketchOpen ? (
          <Suspense fallback={null}>
            <SketchDialog
              open
              onOpenChange={setSketchOpen}
              onComplete={async (file) => {
                const attached = await addAttachments([file]);
                if (!attached) throw new Error("Sketch attachment was rejected.");
              }}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
