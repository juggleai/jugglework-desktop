import type { CloudDocsBridge } from "@/app/lib/cloud-docs-types";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { createDenClient, readDenSettings, readDenUserId } from "@/app/lib/den";
import { clearWordIntakeRequest, saveWordIntakeRequest } from "./word-intake-request";

/** 在原 Word 页面完成上传及首次双向关联；文件读取复用所属工作区客户端。 */
export async function uploadWord(input: {
  bridge: CloudDocsBridge;
  fileClient: Pick<JuggleWorkServerClient, "statWorkspaceFile" | "downloadWorkspaceFile">;
  documentId: string;
  localWorkspaceId: string;
  relativePath: string;
  savedFileSha256: string;
  title: string;
}) {
  const { bridge, fileClient } = input;
  const settings = readDenSettings();
  const sourceUserId = readDenUserId();
  const tenantId = settings.activeOrgId;
  if (!settings.authToken || !tenantId || !sourceUserId) throw new Error("word_organization_required");
  const assertScope = () => {
    const current = readDenSettings();
    if (current.baseUrl !== settings.baseUrl || current.activeOrgId !== tenantId ||
      current.authToken !== settings.authToken || readDenUserId() !== sourceUserId)
      throw new Error("word_source_changed");
  };
  const request = saveWordIntakeRequest({
    tenantId, documentId: input.documentId, localWorkspaceId: input.localWorkspaceId,
    relativePath: input.relativePath, savedFileSha256: input.savedFileSha256,
    title: input.title, sourceServerOrigin: settings.baseUrl, sourceUserId,
  });
  const snapshot = await bridge.readWordBlocks(input.documentId);
  const stat = await fileClient.statWorkspaceFile(input.localWorkspaceId, input.relativePath);
  if (!stat.exists || stat.kind !== "file" || !Number.isSafeInteger(stat.size) || stat.size! <= 0)
    throw new Error("word_file_unavailable");
  if (stat.size! > 10 * 1024 * 1024) throw new Error("word_file_too_large");
  const original = await fileClient.downloadWorkspaceFile(input.localWorkspaceId, input.relativePath);
  if (original.data.byteLength > 10 * 1024 * 1024) throw new Error("word_file_too_large");
  const digest = await crypto.subtle.digest("SHA-256", original.data);
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const originalBlobKey = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_");
  if (checksum !== input.savedFileSha256) throw new Error("word_file_changed_after_save");
  assertScope();
  const client = createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken });
  const instanceId = crypto.randomUUID();
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  // TIPS: product 原生页只作为后台接入宿主，不设置可见区域，不切换路由或关闭 Word。
  const ready = new Promise<void>((resolve, reject) => {
    unsubscribe = bridge.onState(state => {
      if (state.instanceId !== instanceId) return;
      if (state.status === "ready") resolve();
      else if (state.status === "error" || state.status === "unauthorized") reject(new Error("word_docs_unavailable"));
    });
    timer = setTimeout(() => reject(new Error("word_docs_unavailable")), 30000);
  });
  // 提前处理拒绝，避免授权请求失败时后台等待产生未处理拒绝。
  void ready.catch(() => undefined);
  try {
    const launch = await client.launchCloudDocs({ tenantId, target: { kind: "home" }, presentation: { instanceId, mode: "product" } });
    assertScope();
    await bridge.open({ ...launch, instanceId, sourceServerOrigin: settings.baseUrl, sourceUserId });
    await ready;
    assertScope();
    const fileName = original.filename || input.relativePath.split(/[\\/]/).pop() || `${input.title}.docx`;
    const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
    const created = await bridge.createWordPage({ instanceId, requestId: request.requestId, title: input.title,
      // TIPS: SDK 快照还包含 start 等本地定位字段，不能透传到云端严格校验的文档协议。
      blocks: snapshot.blocks.map(({ id, text, kind, marks }) => ({ id, text, kind, marks })),
      fileName, mimeType, fileData: original.data, checksum });
    assertScope();
    const editorInstance = crypto.randomUUID();
    const editorLaunch = await client.launchCloudDocs({ tenantId,
      target: { kind: "page", pageId: created.pageId, workspaceId: created.workspaceId },
      presentation: { instanceId: editorInstance, mode: "editor" } });
    assertScope();
    const attachmentId = crypto.randomUUID();
    await bridge.linkWord({ ...editorLaunch, attachmentId, documentId: input.documentId,
      localWorkspaceId: input.localWorkspaceId, relativePath: input.relativePath,
      instanceId: editorInstance, sourceServerOrigin: settings.baseUrl, sourceUserId,
      pageId: created.pageId, bindings: [], deriveBindings: true,
      original: { sourceId: originalBlobKey, name: fileName, size: original.data.byteLength, type: mimeType } });
    try { assertScope(); } catch (error) {
      await bridge.pauseWord(attachmentId);
      throw error;
    }
    clearWordIntakeRequest(request.requestId);
    return { attachmentId, tenantId, pageId: created.pageId, workspaceId: created.workspaceId };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await bridge.close(instanceId).catch(() => undefined);
  }
}
