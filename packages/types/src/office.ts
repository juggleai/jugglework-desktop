/** 已接入宿主保存和关闭流程的原生 Office 格式。 */
export const OFFICE_EDITABLE_FORMATS = ["docx", "csv", "xlsx", "pptx"] as const;

/**
 * 统一确定文件对应的原生编辑模型，侧栏、独立窗口和服务端使用相同格式边界。
 * @param path 文件路径，保留原始路径及大小写，仅按扩展名匹配
 * @returns Word、表格或幻灯片模型类型；尚未接入的格式返回 null
 */
export function getOfficeDocumentKind(
  path: string,
): "doc" | "sheet" | "slide" | null {
  if (/\.docx$/i.test(path)) return "doc";
  if (/\.(?:csv|xlsx)$/i.test(path)) return "sheet";
  if (/\.pptx$/i.test(path)) return "slide";
  return null;
}

/** 本地 Office 引擎能力；仅开放已接入宿主生命周期的格式。 */
export interface OfficeCapabilities {
  available: boolean;
  formats: string[];
  reason?: string;
  engineVersion?: string;
}

/** 一个已绑定工作区文件的编辑会话，文件路径不能通过保存动作改变。 */
export interface OfficeDocumentSession {
  documentId: string;
  pageId: string;
  artifactId: string;
  workspaceId: string;
  ownerSessionId: string;
  relativePath: string;
  name: string;
  state: "opening" | "ready" | "saving" | "external" | "error" | "closed";
  engineFileId: string | null;
  previewUrl: string | null;
  dirty: boolean;
  savedAt: number | null;
  error?: string;
}

/** 迁移前由所属聊天和交付状态决定的等待原因；null 表示当前可迁移。 */
export interface OfficeTransferStatus {
  documentId: string;
  reason: "running" | "finalizing" | "saving" | null;
}

/** 原生编辑页当前选区；模型身份由宿主提供，页面中的 fileId 不参与目标选择。 */
export interface OfficeSelection {
  kind: "doc" | "sheet" | "slide";
  data: Record<string, unknown>;
  capturedAt: number;
}
