/** 宿主的展示配置，不携带账号、授权或正文。 */
export interface CloudDocsAppearance {
  theme: "light" | "dark";
  locale: string;
  fontFamily: string;
  colors: Record<
    | "background"
    | "foreground"
    | "sidebar"
    | "border"
    | "muted"
    | "accent"
    | "accentForeground",
    string
  >;
}

export type CloudDocsPageTarget =
  | { kind: "home" }
  | { kind: "page"; pageId: string; workspaceId?: string; commentId?: string };

/** 供主窗刷新使用的定位与当前源身份，不带授权数据。 */
export interface CloudDocsResumeScope {
  sourceServerOrigin: string;
  sourceUserId: string;
  tenantId: string;
  target: CloudDocsPageTarget;
}

type CloudDocsWorkTiming = { runtimeConfigMs: number; launchRequestMs: number };
type CloudDocsWarmupScope = Omit<CloudDocsResumeScope, "target"> & { authFingerprint: string };

/** 仅主宿主可调用的原生云文档能力，不向远程页面暴露。 */
export interface CloudDocsBridge {
  /** 将宿主导航提示绘制在当前原生视图上。 */
  setRailHint?(input: { instanceId: string; hint: { label: string; centerY: number; dark: boolean } | null }): void;
  /** 执行 AFFiNE 原生侧栏或搜索展示操作，不涉及文档写入。 */
  layoutCommand(input: { instanceId: string; action: "toggle-left" | "toggle-right" | "search" | "request-state" }): void;
  /** 监听当前实例真实侧栏状态。 */
  onLayout(callback: (value: { instanceId: string; layout: { leftOpen: boolean; leftWidth: number; rightOpen: boolean } }) => void): () => void;
  /** 打开授权原生视图，可附带 Work 启动接口的本地耗时。 */
  open(input: {
    instanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
    bootstrapUrl: string;
    docsOrigin: string;
    launchGrant: string;
    startupLaunchMs?: number;
    startupWorkTiming?: CloudDocsWorkTiming;
    fullPage?: boolean;
    warmup?: boolean;
    authFingerprint?: string;
    /** 后台上传／AI 产品页不替换前台页面，完成后按实例独立释放。 */
    background?: boolean;
    /** 前台页面切换展示区域时保留实例，隐藏期间继续保存，宿主卸载时释放。 */
    retain?: boolean;
    presentation?: { instanceId: string; mode: "product" | "manage" };
  }): Promise<{ instanceId: string }>;
  /** 查找同窗口、同账号与租户的实际位置，返回值仅用于申请新 grant。 */
  resumeCandidate?(input: CloudDocsResumeScope): Promise<{ instanceId: string; docsOrigin?: string; target: CloudDocsPageTarget } | null>;
  /** 使用当前 grant 复核候选，成功后仍由正常 bounds 显示。 */
  resume?(input: CloudDocsResumeScope & {
    instanceId: string;
    bootstrapUrl: string;
    docsOrigin: string;
    launchGrant: string;
    startupLaunchMs?: number;
    startupWorkTiming?: CloudDocsWorkTiming;
  }): Promise<"resumed" | "fallback" | "retry" | "denied">;
  /** 获取本进程唯一预热登记。 */
  warmupReserve?(input: CloudDocsWarmupScope): Promise<{ instanceId: string; docsOrigin: string; target: CloudDocsPageTarget } | null>;
  /** 等待已登记的同目标预热，并把视图交给显式打开。 */
  warmupClaim?(input: CloudDocsWarmupScope & { target: CloudDocsPageTarget }): Promise<string | null>;
  /** 取消指定的未接管预热。 */
  warmupCancel?(input: { instanceId: string }): Promise<null>;
  /** 监听 Main 作废的预热登记，以取消当前连接请求。 */
  onWarmupCancelled?(callback: (instanceId: string) => void): () => void;
  /** 关闭视图。未确认保存时保留页面；切换组织可要求所有视图保存后一起关闭。 */
  close(instanceId?: string, options?: { requireSaved?: boolean; forgetRecent?: boolean }): Promise<{ closed: boolean }>;
  /** 获取当前实例画面，供宿主浮窗覆盖原生视图时保留页面背景。 */
  snapshot(instanceId: string): Promise<string | null>;
  /** 查询已登记实例状态，不重新申请登录交接。 */
  status?(instanceId: string): Promise<{ ready: boolean; status?: "loading" | "ready" | "error" | "unauthorized"; workspaceId?: string; docId?: string | null; title?: string }>;
  /** 更新当前实例的主题、语言和界面配色。 */
  setAppearance(input: {
    instanceId: string;
    appearance: CloudDocsAppearance;
  }): void;
  /** 按宿主容器的尺寸、圆角和可见状态布局原生云文档视图。 */
  setBounds(input: {
    instanceId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    borderRadius?: number;
    visible: boolean;
  }): void;
  onState(
    callback: (state: {
      instanceId: string;
      status: "loading" | "ready" | "error" | "unauthorized";
      workspaceId?: string;
      docId?: string | null;
      title?: string;
    }) => void,
  ): () => void;
  /** 在当前组织的 Docs 视图查重、上传文件，或确认与取消原转换任务。 */
  fileIntake(
    input:
      | { action: "lookup"; instanceId?: string; tenantId?: string; requestId: string; checksum: string }
      | { action: "commit"; instanceId: string; requestId: string; checksum: string; warningAckDigest: string }
      | { action: "cancel"; instanceId: string; requestId: string; checksum: string }
      | {
          action: "upload";
          instanceId?: string;
          tenantId?: string;
          requestId: string;
          checksum: string;
          fileName: string;
          mimeType: string;
          fileData: ArrayBuffer;
        },
  ): Promise<CloudFileIntakeResult>;
  /** 在会议窗口中打开文档视图，位置由会议界面通过 bounds 同步。 */
  meetingOpen?(input: {
    instanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
    bootstrapUrl: string;
    docsOrigin: string;
    launchGrant: string;
    presentation: { instanceId: string; mode: "product" };
  }): Promise<{ instanceId: string }>;
  /** 向会议文档视图下发共享人视口、页内跳转或本地缩放。 */
  meetingCommand?(input:
    | { instanceId: string; action: "apply-viewport"; payload: { follow: boolean; sharerName?: string; viewport: CloudDocsMeetingViewport } }
    | { instanceId: string; action: "open-page"; payload: { docId: string } }
    | { instanceId: string; action: "zoom"; payload: { factor: number } }): void;
  /** 监听会议文档视图上报的本页视口与共享人相对位置。 */
  onMeetingEvent?(callback: (event: CloudDocsMeetingEvent) => void): () => void;
  /** 滚动并高亮当前页面中的指定块。 */
  highlightBlocks(input: { instanceId: string; docId: string; blockIds: string[] }): void;
  /** 在当前 product 视图中执行 Docs AI 接口。 */
  api(input: { instanceId?: string; tenantId?: string; requestId: string; op: "search" | "read" | "edit" | "create" | "docs-recent" | "docs-search"; params: Record<string, unknown> }): Promise<{ status: number; body: unknown }>;
  /** 监听本地 Server 经主进程转来的云文档请求。 */
  onApiRequest(callback: (request: { requestId: string; tenantId: string; op: "search" | "read" | "edit" | "create" | "import"; params: Record<string, unknown> }) => void): () => void;
  /** 返回云文档请求结果。 */
  apiResponse(value: { requestId: string; ok: boolean; status?: number; body?: unknown; error?: string }): void;
  /** 监听页面发来的块选区引用。 */
  onAiReference(callback: (value: CloudDocsAiReference) => void): () => void;
}

/** 共享人视口：页面模式用块锚点，白板模式用画布坐标；不含正文或标题。 */
export type CloudDocsMeetingViewport = {
  workspaceId: string;
  docId: string;
  mode: "page" | "edgeless";
  anchor?: { blockId: string; offset: number };
  edgeless?: { centerX: number; centerY: number; zoom: number };
};
export type CloudDocsMeetingEvent =
  | { instanceId: string; type: "docs.viewport"; meeting: CloudDocsMeetingViewport & { userInput: boolean } }
  | { instanceId: string; type: "docs.sharer-relation"; meeting: { direction: "above" | "below" | "visible" | "missing"; heading: string } };

/** 文件接入结果：lookup 返回 existing，upload 返回页面与警告。 */
export type CloudFileIntakeResult = {
  existing?: Array<{ workspaceId: string; pageId: string; fileName: string; createdAt: string }>;
  workspaceId?: string;
  pageId?: string;
  state?: string;
  warnings?: string[];
  warningDigest?: string;
};

/** 页面选区引用，只含 blockId，不含正文。 */
export type CloudDocsAiReference = {
  instanceId: string;
  tenantId: string;
  workspaceId: string;
  docId: string;
  title: string;
  action: "add" | "ask";
  blockIds: string[];
};
