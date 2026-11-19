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

/** 仅主宿主可调用的原生云文档能力，不向远程页面暴露。 */
export interface CloudDocsBridge {
  /** 执行 AFFiNE 原生侧栏或搜索展示操作，不涉及文档写入。 */
  layoutCommand(input: { instanceId: string; action: "toggle-left" | "toggle-right" | "search" | "request-state" }): void;
  /** 监听当前实例真实侧栏状态。 */
  onLayout(callback: (value: { instanceId: string; layout: { leftOpen: boolean; leftWidth: number; rightOpen: boolean } }) => void): () => void;
  open(input: {
    instanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
    bootstrapUrl: string;
    docsOrigin: string;
    launchGrant: string;
    /** 后台上传／AI 产品页不替换前台页面，完成后按实例独立释放。 */
    background?: boolean;
    /** 前台页面切换展示区域时保留实例，隐藏期间继续保存，宿主卸载时释放。 */
    retain?: boolean;
    presentation?: { instanceId: string; mode: "product" | "manage" };
  }): Promise<{ instanceId: string }>;
  /** 关闭视图。未确认保存时保留页面；切换组织可要求所有视图保存后一起关闭。 */
  close(instanceId?: string, options?: { requireSaved?: boolean }): Promise<{ closed: boolean }>;
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
  /** 滚动并高亮当前页面中的指定块。 */
  highlightBlocks(input: { instanceId: string; docId: string; blockIds: string[] }): void;
  /** 在当前 product 视图中执行 Docs AI 接口。 */
  api(input: { instanceId?: string; tenantId?: string; requestId: string; op: "search" | "read" | "edit" | "create"; params: Record<string, unknown> }): Promise<{ status: number; body: unknown }>;
  /** 监听本地 Server 经主进程转来的云文档请求。 */
  onApiRequest(callback: (request: { requestId: string; tenantId: string; op: "search" | "read" | "edit" | "create" | "import"; params: Record<string, unknown> }) => void): () => void;
  /** 返回云文档请求结果。 */
  apiResponse(value: { requestId: string; ok: boolean; status?: number; body?: unknown; error?: string }): void;
  /** 监听页面发来的块选区引用。 */
  onAiReference(callback: (value: CloudDocsAiReference) => void): () => void;
}

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
