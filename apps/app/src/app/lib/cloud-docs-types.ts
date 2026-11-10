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
    launchGrant: string;
    presentation?: { instanceId: string; mode: "product" | "manage" | "editor" };
  }): Promise<{ instanceId: string }>;
  close(instanceId?: string): Promise<void>;
  /** 更新当前实例的主题、语言和界面配色。 */
  setAppearance(input: {
    instanceId: string;
    appearance: CloudDocsAppearance;
  }): void;
  setBounds(input: {
    instanceId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
  }): void;
  onState(
    callback: (state: {
      instanceId: string;
      status: "loading" | "ready" | "error" | "unauthorized";
      workspaceId?: string;
    }) => void,
  ): () => void;
  /** 使用文件接入阶段返回的稳定对象映射建立 Word 双向关联。 */
  createWordPage(input: {
    instanceId: string;
    requestId: string;
    title: string;
    blocks: Array<{
      id: string;
      text: string;
      kind: string;
      marks: Array<{
        index: number;
        length: number;
        bold: boolean;
        italic: boolean;
      }>;
    }>;
    fileName: string;
    mimeType: string;
    fileData: ArrayBuffer;
    checksum: string;
  }): Promise<{
    workspaceId: string;
    pageId: string;
    resultPageId: string;
    title: string;
    state: "completed";
    checksum: string;
    originalFileUrl: string;
  }>;
  /** 读取当前真实 Word 基础对象；正式关联时仍会再次核对。 */
  readWordBlocks(documentId: string): Promise<{
    blocks: Array<{
      id: string;
      text: string;
      kind: string;
      marks: Array<{
        index: number;
        length: number;
        bold: boolean;
        italic: boolean;
      }>;
    }>;
  }>;
  /** 按当前账号、组织和本地文件精确查找待恢复关联。 */
  findWordRecovery(input: {
    documentId: string;
    localWorkspaceId: string;
    relativePath: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
  }): Promise<{
    attachmentId: string;
    docsWorkspaceId: string;
    pageId: string;
    relocationRequired: boolean;
    previousRelativePath?: string;
  } | null>;
  /** 用户确认后按共同检查点摘要重新定位已移动的 Word 文件。 */
  relocateWord(input: {
    attachmentId: string;
    documentId: string;
    localWorkspaceId: string;
    relativePath: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
  }): Promise<{ status: "relocated" }>;
  /** 重新授权同一原生页面并完成共同检查点恢复。 */
  recoverWord(input: {
    attachmentId: string;
    documentId: string;
    localWorkspaceId: string;
    relativePath: string;
    instanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
    bootstrapUrl: string;
    launchGrant: string;
    pageId: string;
  }): Promise<{
    status: "active" | "paused";
    attachmentId?: string;
    pageId?: string;
    reason?: string;
  }>;
  /** 账号或组织变化时暂停当前关联，不删除持久检查点。 */
  pauseWord(attachmentId: string): Promise<{ status: "detached" }>;
  /** 使用文件接入阶段返回的稳定对象映射建立 Word 双向关联。 */
  linkWord(input: {
    attachmentId: string;
    documentId: string;
    localWorkspaceId: string;
    relativePath: string;
    instanceId: string;
    sourceServerOrigin: string;
    sourceUserId: string;
    tenantId: string;
    bootstrapUrl: string;
    launchGrant: string;
    pageId: string;
    bindings: Array<{ paragraphId: string; blockId: string }>;
    deriveBindings?: boolean;
    original?: {
      sourceId: string;
      name: string;
      size: number;
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    };
  }): Promise<{ status: "active"; attachmentId: string }>;
  /** 释放指定 Word 双向关联。 */
  unlinkWord(attachmentId: string): Promise<{ status: "detached" }>;
  /** 查询当前 Word 双向关联状态。 */
  wordState(attachmentId: string): Promise<Record<string, unknown>>;
  /** 等待当前对象操作窗口结束。 */
  flushWord(attachmentId: string): Promise<Record<string, unknown>>;
  /** 监听 Word 双向关联生命周期。 */
  onWordState(
    callback: (state: {
      attachmentId: string;
      status: string;
      reason?: string;
      documentId?: string;
      pageId?: string;
    }) => void,
  ): () => void;
}
