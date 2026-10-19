/** 原生工具元信息；完整目录留在宿主，模型按需获取单项 schema。 */
export interface OfficeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** 内容通道不开放原生生命周期、批量调用或跨文档导入导出。 */
export function isOfficeContentTool(name: string): boolean {
  return (
    /^(?:doc_|sheet_|slide_)/.test(name) &&
    ![
      "doc_batch_execute",
      "doc_compare_documents",
      "doc_copy_content_from",
      "doc_to_image",
    ].includes(name)
  );
}
