/** 独立文件窗口的标签身份；相同文件沿用所属聊天及 Office 模型。 */
export interface FileWindowTab {
  path: string;
  name: string;
  /** 系统明确选择文件的原位置，仅本机文件标签提供；不授予父目录能力。 */
  absolutePath?: string;
  documentId?: string;
  /** 已确认存在导入损失时，使用原文件只读预览，不创建编辑模型。 */
  readOnly?: boolean;
}

/** 窗口状态由 Electron 维护，最近文件不包含访问令牌。 */
export interface FileWindowState {
  workspaceId: string;
  sessionId: string;
  workspaceRoot: string;
  /** 系统明确打开的文件集合，不是聊天工作区；不提供工作区新建入口。 */
  local?: boolean;
  tabs: FileWindowTab[];
  activePath: string | null;
  recent: FileWindowTab[];
  platform: string;
}

/** 宿主允许用户手动新建的 Office 格式。 */
export type OfficeCreationKind = "docx" | "pptx";

/** 独立窗口最小桥；文件操作通过同一 Server 和原生对话框执行。 */
export interface FileWindowBridge {
  /** 查询当前主进程是否已注册文件窗口入口，兼容开发时尚未重启的旧主进程。 */
  available?(): Promise<boolean>;
  open(input: {
    workspaceId: string;
    sessionId: string;
    path: string;
  }): Promise<void>;
  state(): Promise<FileWindowState & { baseUrl: string; token: string }>;
  /** 原生选择目标路径并创建文件；取消时返回 null。 */
  create(input: {
    workspaceId: string;
    sessionId: string;
    kind: OfficeCreationKind;
  }): Promise<{ path: string } | null>;
  action(
    action: "select" | "close" | "open" | "reveal" | "save-copy",
    path?: string,
  ): Promise<void>;
  onChanged(callback: (state: FileWindowState) => void): () => void;
  /** 在主窗口编辑区选择文件后，复用所属聊天的右侧文件标签。 */
  onOpenInPanel?(
    callback: (input: {
      workspaceId: string;
      sessionId: string;
      path: string;
    }) => void,
  ): () => void;
}
