import { readFile } from "node:fs/promises";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { loopbackFetch } from "../server-fetch.js";

/** 向所属桌面原生页面发送固定契约请求，不激活窗口或解释页面模型。 */
async function requestOfficePage(
  document: OfficeDocumentSession,
  route: "prepare-save" | "selection",
): Promise<{ selection?: unknown } | null> {
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
    }),
    signal: AbortSignal.timeout(route === "prepare-save" ? 12_000 : 2_000),
  });
  const result = (await response.json()) as {
    ok?: boolean;
    error?: string;
    selection?: unknown;
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

/** 按文档及页面代次读取当前原生选区；无桌面或通道不可用时不沿用历史坐标。 */
export async function readOfficePageSelection(
  document: OfficeDocumentSession,
): Promise<unknown> {
  const result = await requestOfficePage(document, "selection");
  return result?.selection ?? null;
}
