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
  /** 规范化坐标；仅用于定位，尚未通过模型及内容证明时不构成执行授权。 */
  locator: OfficeSelectionLocator | null;
  capturedAt: number;
}

/** Word 原生 DOC 坐标半开区间，不能由显示文本长度推算。 */
export interface OfficeTextRange {
  begin: number;
  end: number;
}

/** 表格零起始闭区间，不把不相邻范围合并为外包矩形。 */
export interface OfficeGridRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/** 行或列的零起始闭区间；只由已验证的原生完整行列选择建立。 */
export interface OfficeDimensionRange {
  start: number;
  end: number;
}

/**
 * 八类原生定位。坐标与文件、模型代次及内容证明分开，不能单凭此对象执行修改。
 * slide-text 的 start/count 使用 UTF-16 码元，包含原生段落分隔符。
 */
export type OfficeSelectionLocator =
  | { kind: "doc-text"; ranges: OfficeTextRange[] }
  | { kind: "doc-caret"; idx: number }
  | { kind: "sheet-cells"; sheetId: string; ranges: OfficeGridRange[] }
  | { kind: "sheet-rows"; sheetId: string; ranges: OfficeDimensionRange[] }
  | { kind: "sheet-columns"; sheetId: string; ranges: OfficeDimensionRange[] }
  | { kind: "slide-pages"; pageIndices: number[] }
  | { kind: "slide-shapes"; pageIndex: number; shapeIds: string[] }
  | {
      kind: "slide-text";
      pageIndex: number;
      shapeId: string;
      start: number;
      count: number;
    };

/** 输入栏及历史显示的预览；名称、范围文案及截断文字不能用作执行坐标。 */
export interface OfficeSelectionPreview {
  name: string;
  range: string;
  text: string;
  /** 工作区展示路径；打开仍由宿主解析，不能据此替换引用模型。 */
  path?: string;
}

/**
 * 宿主固定引用契约；由 Server 生成，页面与 Agent 不能自行登记模型归属。
 * contentStamp 对应完整内容证明，preview 仅供展示。
 */
export interface OfficeSelectionReference {
  referenceId: string;
  workspaceId: string;
  ownerSessionId: string;
  documentId: string;
  modelGeneration: string;
  captureId: string;
  sourcePageId: string;
  locator: OfficeSelectionLocator;
  contentStamp: string;
  capturedAt: number;
  preview: OfficeSelectionPreview;
}

/** 修改要求按稳定身份与引用关联；移除标签不能把要求隐式改投当前文件。 */
export type OfficeSelectionInstruction = {
  instructionId: string;
  text: string;
} & (
  | { bindingState: "bound"; referenceIds: string[] }
  | { bindingState: "needs-selection" | "detached"; referenceIds: [] }
);

/** 主窗口和 Office 宿主之间的有限草稿协议，页面不参与聊天身份解析。 */
export type OfficeComposerRequest = {
  requestId: string;
  workspaceId: string;
  sessionId: string;
} & (
  | { action: "prepare" }
  | { action: "append"; reference: OfficeSelectionReference; instructionId: string; epoch: number; text: string; mode: "add" | "send" }
  | { action: "guard"; targetDocumentId?: string | null; path?: string; closingDocumentId?: string }
  | { action: "clear"; epoch: number; referenceIds: string[]; scope: string }
);
