import { readFile } from "node:fs/promises";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { loopbackFetch } from "../server-fetch.js";

/** 向所属桌面原生页面发送固定契约请求，不激活窗口或解释页面模型。 */
async function requestOfficePage(
  document: OfficeDocumentSession,
  route: "prepare-save" | "saved" | "selection" | "text",
  input: Record<string, unknown> = {},
): Promise<{ selection?: unknown; texts?: unknown } | null> {
  const discovery = process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY?.trim();
  if (!discovery) return null;
  const bridge = JSON.parse(await readFile(discovery, "utf8"));
  if (typeof bridge.baseUrl !== "string" || typeof bridge.token !== "string")
    throw new Error("桌面文档保存通道不可用");
  const response = await loopbackFetch(`${bridge.baseUrl}/office/${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: document.workspaceId,
      documentId: document.documentId,
      pageId: document.pageId,
      ...input,
    }),
    signal: AbortSignal.timeout(
      ["prepare-save", "saved"].includes(route) ? 12_000 : 2_000,
    ),
  });
  const result = (await response.json()) as {
    ok?: boolean;
    error?: string;
    selection?: unknown;
    texts?: unknown;
  };
  if (!response.ok || result.ok !== true)
    throw new Error(result.error ?? "桌面文档页面确认失败");
  return result;
}

/** 保存前确认所属桌面 Office 页面输入已提交；纯引擎宿主无需页面确认。 */
export async function prepareOfficePageSave(
  document: OfficeDocumentSession,
): Promise<void> {
  if (!/\.(?:docx|csv|xlsx|pptx)$/i.test(document.relativePath)) return;
  await requestOfficePage(document, "prepare-save");
}

/** Office 文件和模型稳定后把真实摘要回执交给桌面共同检查点控制器。 */
export async function confirmOfficePageSaved(
  document: OfficeDocumentSession,
): Promise<void> {
  if (!/\.docx$/i.test(document.relativePath)) return;
  // TIPS: 共同检查点必须使用本次真实保存回执，不能只传模型身份导致确认被跳过。
  await requestOfficePage(document, "saved", {
    savedAt: document.savedAt,
    savedFileSha256: document.savedFileSha256,
  });
}

/** 按文档及页面代次读取当前原生选区；无桌面或通道不可用时不沿用历史坐标。 */
export async function readOfficePageSelection(
  document: OfficeDocumentSession,
): Promise<unknown> {
  const result = await requestOfficePage(document, "selection");
  return result?.selection ?? null;
}

/** 从所属原生模型读取有界正文，保留结构预览省略的段内换行；无页面时保持拒绝。 */
export async function readOfficePageText(document: OfficeDocumentSession, ranges: { begin: number; end: number }[], version: number): Promise<string[] | null> {
  const result = await requestOfficePage(document, "text", { ranges, version });
  if (!Array.isArray(result?.texts) || result.texts.length !== ranges.length || result.texts.some((text) => typeof text !== "string")) return null;
  return result.texts as string[];
}
