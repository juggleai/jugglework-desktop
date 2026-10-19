import type { OfficeSelectionInstruction, OfficeSelectionReference } from "@jugglework/types/office";
import type { ComposerDraft, ComposerPart } from "@/app/types";

/** 一段要求及其显式引用；文字在组内编辑，文件切换不靠文字邻接关系推断目标。 */
export interface OfficeComposerGroup {
  instruction: OfficeSelectionInstruction;
  references: OfficeSelectionReference[];
}

/** 只把宿主登记的组身份放入编辑器文本，不把坐标放入可编辑字符串。 */
export function officeInstructionToken(id: string): string { return `[office-instruction ${id}]`; }

/** 从有序草稿提取主机字段；需要重新选择的要求不能悄悄降级为普通当前文件编辑。 */
export function officeSubmissionFromDraft(draft: ComposerDraft) {
  const groups = draft.parts.filter((part): part is Extract<ComposerPart, { type: "office-selection" }> => part.type === "office-selection");
  if (!groups.length) return {};
  const ids = groups.map((group) => group.instruction.instructionId);
  if (new Set(ids).size !== ids.length) throw new Error("选区要求重复，请移除重复标签后重试");
  for (const group of groups) {
    if (group.instruction.bindingState === "needs-selection") throw new Error("请重新选择要修改的内容，或明确将要求改为普通文本");
    if (group.instruction.bindingState === "bound" && (!group.instruction.referenceIds.length ||
      group.instruction.referenceIds.some((id) => !group.references.some((ref) => ref.referenceId === id))))
      throw new Error("选区已失效，请重新选择");
  }
  const ordinaryText = draft.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  if (!ordinaryText && !groups.some((group) => group.instruction.text.trim())) throw new Error("请输入希望如何修改选区");
  return {
    officeSelectionRefs: [...new Set(groups.flatMap((group) => group.instruction.bindingState === "bound" ? group.instruction.referenceIds : []))],
    officeInstructions: groups.map((group) => structuredClone(group.instruction)),
  };
}

/** 草稿和历史使用可读文案；文件名及显示范围不参与写入授权。 */
export function officeGroupText(group: OfficeComposerGroup): string {
  return `${group.references.map((ref) => `${officeSelectionLabel(ref)}：${ref.preview.name}（${ref.preview.range}）`).join("\n")}${group.references.length ? "\n" : ""}${group.instruction.text}`;
}

/** 用户消息历史只传显示字段；固定引用身份、模型代次和真实坐标留在宿主执行通道。 */
export function officeGroupDisplay(group: OfficeComposerGroup) {
  return { instruction: { text: group.instruction.text }, references: group.references.map((ref) => ({ locator: { kind: ref.locator.kind }, preview: structuredClone(ref.preview) })) };
}

/** 使用统一的三格式标签文案，定位仍取 Server 引用。 */
export function officeSelectionLabel(ref: OfficeSelectionReference): string {
  return ref.locator.kind.startsWith("sheet-") ? "表格选区" : ref.locator.kind.startsWith("slide-") ? "幻灯片选区" : "文档选区";
}
