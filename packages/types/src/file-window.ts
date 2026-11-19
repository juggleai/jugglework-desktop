import type { DesktopConfig } from "./den/desktop-policies.js";

/** 工作区现有内联文本格式；不扩展原生 Office 编辑模型。 */
export const WORKSPACE_TEXT_FILE_EXTENSIONS = [
  "md", "mdx", "markdown", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml",
  "xml", "html", "htm", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "txt", "log",
] as const;

/** 独立窗口已实现的格式；无点扩展名可直接用于原生文件选择框。 */
export const FILE_WINDOW_EXTENSIONS = [
  ...WORKSPACE_TEXT_FILE_EXTENSIONS,
  "docx", "xlsx", "pptx", "xls", "ods", "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
  "mp4", "m4v", "mov", "webm", "ogv", "avi", "mkv",
] as const;

/** 仅按文件名扩展名判定；登记和写入仍需校验真实路径与内容。 */
export function isSupportedWorkspaceTextFilePath(path: string): boolean {
  return WORKSPACE_TEXT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`));
}

/** Main picker、系统 argv 和 Server 登记共用同一格式边界。 */
export function isSupportedFileWindowPath(path: string): boolean {
  return FILE_WINDOW_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`));
}

/** 标签创建时捕获的聊天身份；切换活动标签不能改写该来源。 */
export interface FileWindowSource {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

/** 分组只由 Main / 可信本机文件登记决定，Renderer 不可指定。 */
export type FileWindowGroup =
  | { kind: "file-assistant" }
  | { kind: "conversation"; workspaceId: string; sessionId: string };

export type FileWindowConversation = FileWindowConversationOptions & {
  desktopConfig: DesktopConfig;
};

/** 主窗口首次打开文件会话时的选项快照，不参与跨窗口同步。 */
export interface FileWindowConversationOptions {
  model?: { providerID: string; modelID: string } | null;
  agent?: string | null;
  variant?: string | null;
}

/** 独立文件窗口的标签身份；相同文件沿用所属聊天及 Office 模型。 */
export interface FileWindowTab {
  tabId: string;
  readonly source: FileWindowSource;
  conversation?: FileWindowConversation;
  path: string;
  name: string;
  kind?: "local-file" | "cloud-document" | "cloud-attachment";
  cloudDoc?: { tenantId: string; workspaceId: string; docId: string; instanceId: string; docsOrigin?: string };
  /** 系统明确选择文件的原位置，仅本机文件标签提供；不授予父目录能力。 */
  absolutePath?: string;
  documentId?: string;
  /** 已确认存在导入损失时，使用原文件只读预览，不创建编辑模型。 */
  readOnly?: boolean;
  /** 来自云文档附件的只读副本。 */
  cloudAttachment?: boolean;
  /** 当前账号组织下，该本地文件最近一次上传的链接。 */
  cloudUpload?: { url: string; tenantId: string };
}

/** 最近文件只是重开入口，不具有活标签身份或会话能力。 */
export interface FileWindowRecent {
  path: string;
  name: string;
}

/** 窗口状态由 Electron 维护，不包含访问令牌。 */
export interface FileWindowState {
  group: FileWindowGroup;
  activeTabId: string | null;
  /** 以下顶层身份仅投影活动标签；空窗为三个空字符串，无 conversation。 */
  workspaceId: string;
  sessionId: string;
  workspaceRoot: string;
  /** 系统明确打开的文件集合，不是聊天工作区；不提供工作区新建入口。 */
  local?: boolean;
  tabs: FileWindowTab[];
  activePath: string | null;
  recent: FileWindowRecent[];
  platform: string;
  /** Main 白名单化的已应用界面偏好；旧宿主可缺省，不包含 storage/bootstrap 配置。 */
  appearance?: { lang: "en" | "ja" | "zh" | "vi" | "pt-BR" | "th" | "fr" | "ca" | "es" | "ru"; theme: "light" | "dark" };
  /** 仅真实已有本地会话提供；策略缺失不能以空对象代替。 */
  conversation?: FileWindowConversation;
}

/** 宿主允许用户手动新建的 Office 格式。 */
export type OfficeCreationKind = "docx" | "pptx";

type CloudFileWindowDocument = { tenantId: string; workspaceId: string; docId: string; title: string };

/** 独立窗口最小桥；文件操作通过同一 Server 和原生对话框执行。 */
export interface FileWindowBridge {
  /** 主窗口将已授权的原生云文档交接给现有 File Browser，不传源长期 Token。 */
  openCloud?(input: { workspaceId: string; sessionId: string; document: CloudFileWindowDocument; launch: { tenantId: string; bootstrapUrl: string; docsOrigin: string; launchGrant: string; presentation: { instanceId: string; mode: "product" | "manage" } }; sourceServerOrigin: string; sourceUserId: string; sourceInstanceId?: string }): Promise<void>;
  /** 仅主窗口接收 Main 核验过的云文档新标签请求。 */
  onOpenCloudTabRequest?(callback: (input: {
    sourceInstanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    document: CloudFileWindowDocument;
  }) => void): () => void;
  /** 仅主窗口更新当前来源范围的上传结果，供独立文件窗口展示分享入口。 */
  setCloudUploads?(input: { scope: string | null; records: Array<{ localWorkspaceId: string; path: string; tenantId: string; url: string }> }): Promise<void>;
  /** 查询当前主进程是否已注册文件窗口入口，兼容开发时尚未重启的旧主进程。 */
  available?(): Promise<boolean>;
  open(input: {
    source: FileWindowSource;
    path: string;
    /** 仅可信主窗口可提供；已有文件窗口的选项不会被覆盖。 */
    conversationOptions?: FileWindowConversationOptions;
  }): Promise<void>;
  state(): Promise<FileWindowState & { baseUrl: string }>;
  /** 原生选择目标路径并创建文件；取消时返回 null。 */
  create(input: {
    workspaceId: string;
    sessionId: string;
    kind: OfficeCreationKind;
  }): Promise<{ path: string } | null>;
  action(
    action: "select" | "close" | "open" | "reveal" | "save-copy" | "open-session" | "upload-cloud" | "share-cloud",
    /** select/close/reveal/save-copy/open-session/upload-cloud/share-cloud 使用 tabId；open 使用最近文件 path 或原生选择框。 */
    tabIdOrRecentPath?: string,
  ): Promise<void>;
  onChanged(callback: (state: FileWindowState) => void): () => void;
  onProviderCatalogChanged?(callback: () => void): () => void;
  /** 仅转发既有 OpenCode Event；订阅身份由 preload 私有维护。 */
  subscribeSessionEvents?(input: { workspaceId: string }, listener: (event: { type: string; properties: object }) => void): () => void;
  /** 仅主窗口接收：目标由 Main 已登记文件窗口及当前 run 确认，清理后才允许 abort。 */
  onSessionStopRequest?(callback: (input: { workspaceId: string; sessionId: string }) => Promise<{ ok: true }>): () => void;
  /** 仅主窗口接收：独立文件窗口请求把当前文件上传为云文档。 */
  onUploadCloud?(callback: (input: { workspaceId: string; path: string; requestId?: string; lookup?: boolean }) => void): () => void;
  /** 在主窗口编辑区选择文件后，复用所属聊天的右侧文件标签。 */
  onOpenInPanel?(
    callback: (input: {
      workspaceId: string;
      sessionId: string;
      path: string;
    }) => void,
  ): () => void;
}
