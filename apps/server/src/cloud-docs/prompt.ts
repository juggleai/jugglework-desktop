import { cloudDocTurnSchema } from "./schema.js";

/** 进入模型前将内部草稿标签变为可读描述；历史消息仍可通过展示元数据恢复原子引用。 */
export function normalizeCloudDocPromptParts(parts: unknown): void {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes("[cloud-doc ")) continue;
    const original = part.text;
    part.text = original.replace(/\[cloud-doc ([^\]\s]+)\]/g, (_token: string, encoded: string) => {
      try {
        const ref = JSON.parse(decodeURIComponent(encoded));
        const checked = cloudDocTurnSchema.shape.references.element.safeParse(ref);
        if (!checked.success) return "[无效云文档引用]";
        const title = checked.data.title.replace(/[\r\n《》\[\]]/g, " ") || "无标题";
        return `[云文档《${title}》${checked.data.blockIds?.length ? `·选区 ${checked.data.blockIds.length} 段` : ""}]`;
      } catch { return "[无效云文档引用]"; }
    });
    // TIPS: 编码仅留作界面展示元数据，模型正文不再携带 JSON 与文档定位信息。
    part.metadata = { ...part.metadata, cloudDocSourceText: original };
  }
}
