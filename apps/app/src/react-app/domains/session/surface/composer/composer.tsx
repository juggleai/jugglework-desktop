/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";
import { AppWindowMac, ArrowUp, Check, ChevronRight, FileText, LoaderCircle, Paperclip, Plus, Plug, Square, Terminal, X, Zap } from "lucide-react";
import fuzzysort from "fuzzysort";
import { toast } from "@/components/ui/sonner";
import { JUGGLEWORK_EXTENSION_CATALOG, type McpDirectoryInfo } from "@/app/constants";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "@/app/cloud/import-state";
import type { JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ComposerAttachment, McpServerEntry, McpStatus, McpStatusMap, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
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

type ToolMenuSection = "commands" | "skills" | "mcps" | "extensions" | `plugin:${string}`;

/**
 * 统一加号菜单的条目。
 * - file：打开文件选择器（原附件按钮）。
 * - agent：选择智能体（原 Agent 选择器，选中项带对号，菜单保持打开）。
 * - tools：在加号菜单右侧弹出对应分区的二级内容面板（命令/技能/
 *   Extensions/MCP/云端导入插件），加号菜单本身保持打开。
 */
type PlusMenuEntry =
  | { kind: "file"; id: "file"; label: string }
  | { kind: "agent"; id: string; label: string; name: string | null }
  | { kind: "tools"; id: string; label: string; section: ToolMenuSection };

function isComposerExtensionAvailable(entry: McpDirectoryInfo) {
  const hasSessionSurface = entry.extensionManifest?.contributions?.some((contribution) =>
    contribution.type === "session-side-panel" || contribution.type === "session-rail-item"
  ) === true;
  if (hasSessionSurface) return isJuggleWorkExtensionEnabled(entry);
  return !entry.defaultEnabled || isJuggleWorkExtensionEnabled(entry);
}

type ComposerProps = {
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
const FOCUS_PROMPT_EVENT = "jugglework:focusPrompt";
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

function isLocalCapability(origin: SkillCard["origin"] | McpServerEntry["origin"]) {
  return origin !== "jugglework-connect";
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
  const [mcpStatus, setMcpStatus] = useState<string | null>(props.mcpStatus ?? null);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>(props.mcpStatuses ?? {});
  const [importedPlugins, setImportedPlugins] = useState<CloudImportedPlugin[]>(props.importedPlugins ?? []);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusMenuIndex, setPlusMenuIndex] = useState(0);
  const plusItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuSection, setToolMenuSection] = useState<ToolMenuSection>("commands");
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
  const toolMenuLoadRef = useRef({
    openId: 0,
    commands: false,
    skills: false,
    mcps: false,
    plugins: false,
  });
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(Boolean(props.skills));
  const [mcpLoaded, setMcpLoaded] = useState(Boolean(props.mcpServers));
  const [pluginsLoaded, setPluginsLoaded] = useState(Boolean(props.importedPlugins));
  const [, setExtensionStateVersion] = useState(0);
  const [dropzoneActive, setDropzoneActive] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<LexicalPromptEditorHandle | null>(null);
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
  const nonDefaultAgents = useMemo(() => agents.filter(isNonDefaultAgent), [agents]);

  // 云端导入插件分区（文件数 > 0 才显示），与四个固定插件分区一起出现在
  // 加号菜单的「插件」分组里，点击在右侧弹出该插件的文件列表。
  const pluginSections = useMemo(
    () => importedPlugins
      .filter((plugin) => plugin.files.length > 0)
      .map((plugin) => ({ section: `plugin:${plugin.pluginId}` as const, plugin })),
    [importedPlugins],
  );

  // 统一加号菜单（合并原附件按钮、工具菜单按钮、Agent 选择器）。
  // 「添加」区：文件 + 默认智能体/非默认智能体（选中带对号）。
  // 「插件」区：命令 / 技能 / Extensions / MCP / 云端导入插件，点击后
  // 加号菜单保持不变，右侧弹出对应分区的二级内容面板。
  const plusMenuAgentEntries = useMemo(() => [
    { name: null as string | null, label: t("composer.default_agent") },
    ...nonDefaultAgents.map((agent) => ({
      name: agent.name as string | null,
      label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
    })),
  ], [nonDefaultAgents]);

  const plusMenuEntries = useMemo<PlusMenuEntry[]>(() => [
    { kind: "file", id: "file", label: t("composer.plus_menu_file") },
    ...plusMenuAgentEntries.map((entry) => ({
      kind: "agent" as const,
      id: entry.name ? `agent:${entry.name}` : "agent:",
      label: entry.label,
      name: entry.name,
    })),
    { kind: "tools", id: "tools:commands", label: t("dashboard.commands"), section: "commands" as const },
    { kind: "tools", id: "tools:skills", label: t("dashboard.skills"), section: "skills" as const },
    { kind: "tools", id: "tools:extensions", label: "Extensions", section: "extensions" as const },
    { kind: "tools", id: "tools:mcps", label: t("composer.mcps_label"), section: "mcps" as const },
    ...pluginSections.map(({ section, plugin }) => ({
      kind: "tools" as const,
      id: `tools:${section}`,
      label: plugin.name,
      section,
    })),
  ], [plusMenuAgentEntries, pluginSections]);

  // 普通函数（非 useCallback）：需要始终读取当前渲染的 fileInput 绑定，
  // 与下方 applyCommandSelection 等处理器保持同一模式。
  const activatePlusEntry = (entry: PlusMenuEntry) => {
    if (entry.kind === "file") {
      setPlusMenuOpen(false);
      if (props.attachmentsEnabled) fileInput?.click();
      return;
    }
    if (entry.kind === "agent") {
      // 选择智能体后菜单保持打开：选中态由 props.selectedAgent 驱动，
      // 对号随选择移动，方便连续查看/切换；点击菜单外部或 Esc 关闭。
      if (props.busy) return;
      props.onSelectAgent(entry.name);
      return;
    }
    // 插件分区：加号菜单保持打开，右侧弹出（或收起）对应分区的二级面板。
    // 注意：此路径由 onClick 触发（勿用 onMouseDown）——mousedown 激活会在
    // click 派发前改动 DOM，导致 click 重定向误触其他按钮。
    if (toolMenuOpen && toolMenuSection === entry.section) {
      setToolMenuOpen(false);
      return;
    }
    setMentionOpen(false);
    setMentionItems([]);
    setSlashOpen(false);
    setToolMenuSection(entry.section);
    setToolMenuOpen(true);
  };

  useEffect(() => {
    setSlashOpen(slashOpenNext);
    setMenuIndex(0);
  }, [slashOpenNext, slashQuery]);

  useEffect(() => {
    setMentionOpen(mentionOpenNext);
    setMenuIndex(0);
  }, [mentionOpenNext, mentionQuery]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    void props.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [plusMenuOpen, props.listAgents]);

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
    setMcpStatus(props.mcpStatus ?? null);
    setMcpStatuses(props.mcpStatuses ?? {});
  }, [props.mcpServers, props.mcpStatus, props.mcpStatuses]);

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
    if (!toolMenuOpen) return;
    toolMenuLoadRef.current = {
      openId: toolMenuLoadRef.current.openId + 1,
      commands: false,
      skills: false,
      mcps: false,
      plugins: false,
    };
    setCommandsLoaded(false);
    setSkillsLoaded(Boolean(props.skills));
    setMcpLoaded(Boolean(props.mcpServers));
    setPluginsLoaded(Boolean(props.importedPlugins));
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    if (toolMenuOpen && toolMenuLoadRef.current.commands) return;
    if (toolMenuOpen) toolMenuLoadRef.current.commands = true;
    let cancelled = false;
    const cached = commandsCacheRef.current;
    if (cached !== null) {
      setCommands(cached);
      setCommandsLoading(false);
      if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    setCommandsLoading(true);
    void loadCommands()
      .then((next) => {
        if (!cancelled) {
          setCommands(next);
          if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommands([]);
          if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, toolMenuOpen, loadCommands]);

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
    if (!toolMenuOpen && !plusMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (plusMenuRef.current?.contains(target)) return;
      setToolMenuOpen(false);
      setPlusMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [toolMenuOpen, plusMenuOpen]);

  useEffect(() => {
    if (!plusMenuOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    const listImportedPlugins = listImportedPluginsRef.current;
    if (listImportedPlugins && !toolMenuLoadRef.current.plugins) {
      let cancelled = false;
      toolMenuLoadRef.current.plugins = true;
      setPluginsLoading(true);
      void listImportedPlugins()
        .then((next) => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) {
            setImportedPlugins(next);
            setPluginsLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) {
            setImportedPlugins([]);
            setPluginsLoaded(true);
          }
        })
        .finally(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) setPluginsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [plusMenuOpen, toolMenuOpen]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    if ((slashOpen || toolMenuSection === "skills") && (!toolMenuOpen || !toolMenuLoadRef.current.skills)) {
      let cancelled = false;
      if (toolMenuOpen) toolMenuLoadRef.current.skills = true;
      setSkillsLoading(true);
      void loadSkills()
        .then((next) => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) {
            setSkills(next);
            setSkillsLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) {
            setSkills([]);
            setSkillsLoaded(true);
          }
        })
        .finally(() => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) setSkillsLoading(false);
        });
      return () => {
        cancelled = true;
        if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) {
          toolMenuLoadRef.current.skills = false;
        }
      };
    }
    return undefined;
  }, [loadSkills, slashOpen, toolMenuOpen, toolMenuSection]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    const listMcp = listMcpRef.current;
    // fix(L3): 斜杠菜单与工具菜单必须消费同一份 MCP 清单。
    // before: 只有展开 MCP 分区才加载；after: 输入 `/` 时也加载并参与提示。
    if ((slashOpen || toolMenuSection === "mcps") && listMcp && (!toolMenuOpen || !toolMenuLoadRef.current.mcps)) {
      let cancelled = false;
      if (toolMenuOpen) toolMenuLoadRef.current.mcps = true;
      setMcpLoading(true);
      void listMcp()
        .then((next) => {
          if (cancelled || (toolMenuOpen && toolMenuLoadRef.current.openId !== openId)) return;
          setMcpServers(next.servers);
          setMcpStatuses(next.statuses);
          setMcpStatus(next.status);
          setMcpLoaded(true);
        })
        .catch(() => {
          if (cancelled || (toolMenuOpen && toolMenuLoadRef.current.openId !== openId)) return;
          setMcpServers([]);
          setMcpStatuses({});
          setMcpLoaded(true);
        })
        .finally(() => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) setMcpLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [slashOpen, toolMenuOpen, toolMenuSection]);

  // MCP 只在工具菜单里作只读展示，不进斜杠菜单，也不可选中注入。
  const slashItems = useMemo<ComposerSlashCommandOption[]>(
    () => [...commands, ...connectSkillSlashCommandOptions(skills)],
    [commands, skills],
  );
  const slashFiltered = useMemo(() => {
    if (!slashOpen) return [];
    if (!slashQuery) return slashItems.slice(0, 8);
    return fuzzysort.go(slashQuery, slashItems, { keys: ["name", "description"], limit: 8 }).map((entry) => entry.obj);
  }, [slashItems, slashOpen, slashQuery]);
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
  const toolCommandItems = commands.filter((command) => !command.source || command.source === "command");
  const toolSkillItems = commands.filter((command) => command.source === "skill");
  const toolMcpItems = commands.filter((command) => command.source === "mcp");
  void toolMcpItems;
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
  const activePlugin = toolMenuSection.startsWith("plugin:")
    ? pluginSections.find((entry) => entry.section === toolMenuSection)?.plugin ?? null
    : null;
  const composerExtensions = JUGGLEWORK_EXTENSION_CATALOG.filter((entry) =>
    !builtInExtensionsDisabled &&
    !isJuggleWorkExtensionHidden(entry) && isComposerExtensionAvailable(entry)
  );
  const canSend = props.draft.trim().length > 0 || props.attachments.length > 0;

  useEffect(() => {
    if (!toolMenuSection.startsWith("plugin:")) return;
    if (activePlugin) return;
    setToolMenuSection("commands");
  }, [activePlugin, toolMenuSection]);

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
      setToolMenuOpen(false);
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
    setToolMenuOpen(false);
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
    setToolMenuOpen(false);
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
    setToolMenuOpen(false);
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

  // Listen for cross-app focus + draft flush events. The Solid shell uses
  // these from deep-link handlers, the command palette, and the browser
  // pagehide/beforeunload cycle so no in-flight draft is lost.
  useEffect(() => {
    const handleFocus = () => {
      const root = rootRef.current;
      if (!root) return;
      const editable = root.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus();
    };
    const handleFlush = () => {
      // onDraftChange always runs synchronously on every keystroke, so this
      // listener is effectively a hook for the shell to signal "we're about
      // to unmount, commit any debounced state". Re-fire with the current
      // draft so downstream stores can checkpoint it.
      props.onDraftChange(draftRef.current);
    };
    window.addEventListener(FOCUS_PROMPT_EVENT, handleFocus);
    window.addEventListener(FLUSH_PROMPT_EVENT, handleFlush);
    window.addEventListener("beforeunload", handleFlush);
    window.addEventListener("pagehide", handleFlush);
    return () => {
      window.removeEventListener(FOCUS_PROMPT_EVENT, handleFocus);
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
    const anyMenuOpen = plusMenuOpen || toolMenuOpen || Boolean(activeMenu);
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
        // 分层关闭：二级内容面板开着先收起，加号菜单保持；再按才关菜单。
        if (toolMenuOpen) {
          setToolMenuOpen(false);
        } else {
          setPlusMenuOpen(false);
        }
        return;
      }
    }

    if (toolMenuOpen && event.key === "Escape") {
      event.preventDefault();
      setToolMenuOpen(false);
      return;
    }

    // Input history recall (#2012). Only when no menu is consuming the
    // arrow keys and IME composition is not active.
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !imeActive &&
      !plusMenuOpen &&
      !toolMenuOpen &&
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
    if (!inputFiles.length) return;
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? t("composer.attachments_unavailable"));
      return;
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

  };

  const activeMcpItems = mcpServers.map((entry) => ({
    entry,
    status: toReactMcpStatus(entry.id ?? entry.name, entry, mcpStatuses),
    detail: mcpStatuses[entry.id ?? entry.name],
  }));

  const panelRoundedClass =
    mentionOpen || slashOpen
      ? "rounded-t-[18px] border-t-transparent"
      : "";

  const renderSlashMenu = () => {
    if (!slashOpen) return null;
    return (
      <div className="absolute bottom-full left-[-1px] right-[-1px] z-30">
          <div className="overflow-hidden rounded-t-[20px] border border-dls-border border-b-0 bg-dls-surface shadow-[var(--dls-shell-shadow)]">
            <div
              role="presentation"
              className="max-h-64 overflow-y-auto p-2"
              onMouseDown={(event) => event.preventDefault()}
          >
            {slashFiltered.length > 0 ? (
              <div className="grid gap-1">
                {slashFiltered.map((command, index) => (
                  <button
                    key={command.id}
                    ref={(element) => {
                      menuItemRefs.current[index] = element;
                    }}
                    type="button"
                    className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${activeMenu === "slash" && slashFiltered[menuIndex]?.id === command.id ? "bg-gray-3 text-gray-12" : "text-gray-11"}`}
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
                    <Terminal size={14} className="mt-0.5 shrink-0 text-gray-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="truncate text-xs font-semibold">/{command.name}</div>
                        {command.origin === "jugglework-connect" ? (
                          <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                            {t("composer.source_cloud")}
                          </span>
                        ) : command.source && command.source !== "command" ? (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${command.source === "skill" ? "bg-violet-3/40 text-violet-11" : "bg-cyan-3/40 text-cyan-11"}`}>
                            {command.source === "skill" ? t("composer.skill_source") : t("composer.mcps_label")}
                          </span>
                        ) : null}
                      </div>
                      {command.description ? <div className="truncate text-xs text-gray-10">{command.description}</div> : null}
                      {command.origin === "jugglework-connect" ? (
                        <div className="truncate text-[10px] text-gray-9">
                          {[command.marketplaceName, command.pluginName].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-gray-10">
                {(!commandsLoaded && commandsLoading) || skillsLoading || mcpLoading ? t("composer.loading_commands") : t("composer.no_commands")}
              </div>
            )}
          </div>
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
      className={`sticky bottom-0 ${toolMenuOpen ? "z-50" : "z-20"} bg-gradient-to-t from-dls-surface via-dls-surface/95 to-transparent px-4 pb-2 md:px-8`}
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
              placeholder={t("composer.placeholder")}
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
                    className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-md transition-colors ${plusMenuOpen || toolMenuOpen ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-3"}`}
                    onClick={() => {
                      setMentionOpen(false);
                      setMentionItems([]);
                      setSlashOpen(false);
                      setToolMenuOpen(false);
                      setPlusMenuOpen((value) => !value);
                    }}
                    aria-expanded={plusMenuOpen}
                    aria-haspopup="dialog"
                    title={t("composer.plus_label")}
                  >
                    <Plus size={16} />
                  </button>
                  {plusMenuOpen ? (
                    <div className="absolute bottom-full left-0 z-40 mb-3 w-64 overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                      <div
                        role="presentation"
                        className="max-h-80 overflow-y-auto p-2"
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <div className="border-b border-dls-border px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-10">
                          {t("composer.plus_menu_section_add")}
                        </div>
                        <div className="grid gap-0.5 pt-1">
                          <button
                            ref={(element) => {
                              plusItemRefs.current[0] = element;
                            }}
                            type="button"
                            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-colors ${plusMenuIndex === 0 ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"} ${!props.attachmentsEnabled ? "cursor-not-allowed opacity-60" : ""}`}
                            disabled={!props.attachmentsEnabled}
                            onMouseEnter={() => setPlusMenuIndex(0)}
                            onClick={() => {
                              activatePlusEntry(plusMenuEntries[0]);
                            }}
                          >
                            <Paperclip size={14} className="shrink-0 text-gray-9" />
                            <span className="min-w-0 flex-1 truncate">{t("composer.plus_menu_file")}</span>
                          </button>
                          {plusMenuAgentEntries.map((entry, index) => {
                            const flatIndex = 1 + index;
                            const selected = entry.name === null ? !props.selectedAgent : props.selectedAgent === entry.name;
                            return (
                              <button
                                key={entry.name ?? "default"}
                                ref={(element) => {
                                  plusItemRefs.current[flatIndex] = element;
                                }}
                                type="button"
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${selected || plusMenuIndex === flatIndex ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"} ${props.busy ? "cursor-not-allowed opacity-60" : ""}`}
                                disabled={props.busy}
                                onMouseEnter={() => setPlusMenuIndex(flatIndex)}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  activatePlusEntry(plusMenuEntries[flatIndex]);
                                }}
                              >
                                <span className="min-w-0 truncate">{entry.label}</span>
                                {selected ? <Check size={14} className="shrink-0 text-gray-10" /> : null}
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-2 border-t border-dls-border px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-10">
                          {t("composer.plus_menu_section_plugins")}
                        </div>
                        <div className="grid gap-0.5 pt-1">
                          {plusMenuEntries.slice(1 + plusMenuAgentEntries.length).map((entry, index) => {
                            if (entry.kind !== "tools") return null;
                            const flatIndex = 1 + plusMenuAgentEntries.length + index;
                            // 激活态：右侧二级面板正打开在该分区上。
                            const sectionActive = toolMenuOpen && toolMenuSection === entry.section;
                            return (
                              <button
                                key={entry.id}
                                ref={(element) => {
                                  plusItemRefs.current[flatIndex] = element;
                                }}
                                type="button"
                                aria-expanded={sectionActive}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${sectionActive || plusMenuIndex === flatIndex ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"}`}
                                onMouseEnter={() => setPlusMenuIndex(flatIndex)}
                                onClick={() => {
                                  activatePlusEntry(entry);
                                }}
                              >
                                <span className="min-w-0 truncate">{entry.label}</span>
                                <ChevronRight size={14} className={`shrink-0 transition-transform ${sectionActive ? "rotate-90 text-gray-11" : "text-gray-9"}`} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {/* 二级内容面板：加号菜单保持打开，此面板锚定在加号菜单
                      右侧（left-16.5rem = 菜单宽度 16rem + 0.5rem 间距），
                      展示当前选中分区（命令/技能/Extensions/MCP/插件）的内容。 */}
                  {toolMenuOpen ? (
                    <div className="absolute bottom-full left-[16.5rem] z-40 mb-3 w-[min(calc(100vw-20rem),26rem)] overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                      <div className="subtle-scrollbar m-2 max-h-[19.5rem] min-w-0 overflow-x-hidden overflow-y-auto">
                        <div role="presentation" onMouseDown={(event) => event.preventDefault()}>
                          {toolMenuSection === "commands" ? (
                            toolCommandItems.length > 0 ? (
                              <div className="grid min-w-0 gap-1">
                                {toolCommandItems.map((command) => (
                                  <button
                                    key={command.id}
                                    type="button"
                                    className="flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyCommandSelection(command)}
                                  >
                                    <Terminal size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center gap-2">
                                        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11" title={`/${command.name}`}>
                                          /{command.name}
                                        </div>
                                        {command.origin === "jugglework-connect" ? (
                                          <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                            {t("composer.source_cloud")}
                                          </span>
                                        ) : null}
                                      </div>
                                      {command.description ? (
                                        <div className="truncate text-xs text-gray-10" title={command.description}>{command.description}</div>
                                      ) : null}
                                      {command.origin === "jugglework-connect" ? (
                                        <div
                                          className="truncate text-[10px] text-gray-9"
                                          title={[command.marketplaceName, command.pluginName].filter(Boolean).join(" · ")}
                                        >
                                          {[command.marketplaceName, command.pluginName].filter(Boolean).join(" · ")}
                                        </div>
                                      ) : null}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {!commandsLoaded && commandsLoading ? t("composer.loading_commands") : t("composer.no_commands")}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "skills" ? (
                            skillMenuItems.length > 0 ? (
                              <div className="grid min-w-0 gap-1">
                                {skillMenuItems.map((skill) => (
                                  <button
                                    key={`${skill.origin ?? "local"}:${skill.path || skill.name}`}
                                    type="button"
                                    className="flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applySkillSelection(skill)}
                                  >
                                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center justify-between gap-3">
                                        <div
                                          className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11"
                                          title={`/${skillMenuSlashCommandName(skill)}`}
                                        >
                                          /{skillMenuSlashCommandName(skill)}
                                        </div>
                                        {isLocalCapability(skill.origin) ? (
                                          <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                            {t("composer.source_local")}
                                          </span>
                                        ) : null}
                                      </div>
                                      {skill.description ? (
                                        <div className="truncate text-xs text-gray-10" title={skill.description}>{skill.description}</div>
                                      ) : null}
                                      {skill.origin === "jugglework-connect" ? (
                                        <div
                                          className="truncate text-[10px] text-gray-9"
                                          title={[skill.marketplaceName, skill.pluginName].filter(Boolean).join(" · ")}
                                        >
                                          {[skill.marketplaceName, skill.pluginName].filter(Boolean).join(" · ")}
                                        </div>
                                      ) : null}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {(!skillsLoaded && skillsLoading) || (!commandsLoaded && commandsLoading) ? t("composer.loading_commands") : t("context_panel.no_skills")}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "mcps" ? (
                            activeMcpItems.length > 0 ? (
                              <div className="grid min-w-0 gap-1">
                                {activeMcpItems.map(({ entry, status, detail }) => {
                                  // 输入栏 loader 已严格筛选为当前工作区可用且连接成功；这里保留
                                  // 防御性检查，避免异步状态变化期间插入不可执行的 MCP。
                                  const selectable = status === "connected" && entry.workspaceEnabled !== false;
                                  const description = entry.origin === "jugglework-connect"
                                    ? [entry.marketplaceName, entry.pluginName].filter(Boolean).join(" · ")
                                      || entry.config.url
                                      || "Remote MCP"
                                    : entry.config.type === "remote"
                                      ? entry.config.url ?? entry.config.command?.join(" ") ?? "Remote MCP"
                                      : entry.config.command?.join(" ") ?? "Local MCP";
                                  return (
                                  <button
                                    key={entry.id ?? entry.name}
                                    type="button"
                                    disabled={!selectable}
                                    aria-disabled={!selectable}
                                    title={selectable ? undefined : entry.workspaceEnabled === false
                                      ? t("connect.workspace_disabled_here")
                                      : mcpStatusTooltip(status, detail)}
                                    className={`flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors ${
                                      selectable ? "hover:bg-gray-2/70" : "cursor-default opacity-60"
                                    }`}
                                    onClick={() => applyMcpSelection(entry, status)}
                                  >
                                    <Plug size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11">{entry.name}</div>
                                        <div className="flex shrink-0 items-center gap-1">
                                          {isLocalCapability(entry.origin) ? (
                                            <span className="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                              {t("composer.source_local")}
                                            </span>
                                          ) : null}
                                          {entry.source ? (
                                            <span className="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                              {entry.source === "config.global" ? t("project_extensions.scope_global") : t("project_extensions.scope_workspace")}
                                            </span>
                                          ) : null}
                                          <span
                                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${mcpStatusBadgeClass(status)}`}
                                            title={mcpStatusTooltip(status, detail)}
                                          >
                                            {entry.workspaceEnabled === false ? t("connect.workspace_disabled_here") : formatMcpStatusLabel(status)}
                                          </span>
                                        </div>
                                      </div>
                                      <div
                                        className="w-full truncate text-xs text-gray-10"
                                        title={description}
                                      >
                                        {description}
                                      </div>
                                    </div>
                                  </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {!mcpLoaded && mcpLoading ? t("composer.loading_commands") : (mcpStatus ?? t("context_panel.no_mcp"))}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "extensions" ? (
                            composerExtensions.length > 0 ? (
                              <div className="grid min-w-0 gap-1">
                                {composerExtensions.map((entry) => (
                                  <button
                                    key={entry.id ?? entry.serverName ?? entry.name}
                                    type="button"
                                    className="flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyExtensionSelection(entry)}
                                  >
                                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-white shadow-sm">
                                      {extensionIcon(entry, 16)}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11" title={entry.name}>
                                          {entry.name}
                                        </div>
                                        {entry.defaultEnabled ? (
                                          <span className="shrink-0 rounded-full bg-green-3 px-2 py-0.5 text-[10px] font-medium text-green-11">Enabled</span>
                                        ) : null}
                                      </div>
                                      <div className="truncate text-xs text-gray-10" title={entry.description}>{entry.description}</div>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">No extensions enabled. Open Extensions to enable them.</div>
                            )
                          ) : null}
                          {activePlugin ? (
                            activePlugin.files.length > 0 ? (
                              <div className="grid min-w-0 gap-1">
                                {activePlugin.files.map((file) => (
                                  <button
                                    key={`${file.configObjectId}:${file.path}`}
                                    type="button"
                                    className="flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyPluginFileSelection(file)}
                                  >
                                    <FileText size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11" title={file.title}>
                                          {file.title}
                                        </div>
                                        <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                          {formatPluginObjectType(file.objectType)}
                                        </span>
                                      </div>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">No plugin files imported yet.</div>
                            )
                          ) : toolMenuSection.startsWith("plugin:") ? (
                            <div className="px-3 py-2 text-xs text-gray-10">
                              {!pluginsLoaded && pluginsLoading ? t("composer.loading_commands") : "Plugin files are unavailable."}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
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
                      className="relative inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-full border border-dls-border bg-transparent text-gray-11 transition-colors hover:bg-gray-3"
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
                    title={props.submissionPreparing ? "Preparing connected service tools…" : t("composer.run_task")}
                  >
                    {props.submissionPreparing ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={15} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
