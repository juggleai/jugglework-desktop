/** 历史只保留展示数据，不反序列化固定引用、模型身份或可执行坐标。 */
export function officeSelectionDisplay(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || !("officeSelectionGroup" in metadata)) return undefined;
  const group = metadata.officeSelectionGroup;
  if (!group || typeof group !== "object" || !("instruction" in group) || !("references" in group)) return undefined;
  const instruction = group.instruction;
  if (!instruction || typeof instruction !== "object" || !("text" in instruction) || typeof instruction.text !== "string" || !Array.isArray(group.references)) return undefined;
  const selections = group.references.slice(0, 16).flatMap((ref: unknown) => {
    if (!ref || typeof ref !== "object" || !("preview" in ref) || !("locator" in ref)) return [];
    const preview = ref.preview, locator = ref.locator;
    if (!preview || typeof preview !== "object" || !locator || typeof locator !== "object" || !("kind" in locator) || typeof locator.kind !== "string" ||
      !("name" in preview) || typeof preview.name !== "string" || !("range" in preview) || typeof preview.range !== "string") return [];
    return [{ label: locator.kind.startsWith("sheet-") ? "表格选区" : locator.kind.startsWith("slide-") ? "幻灯片选区" : "文档选区",
      name: preview.name.slice(0, 512), range: preview.range.slice(0, 512), text: "text" in preview && typeof preview.text === "string" ? preview.text.slice(0, 160) : "" }];
  });
  return { text: instruction.text.slice(0, 32_768), selections };
}
