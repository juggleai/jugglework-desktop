import * as React from "react";
import { withProductView } from "./product-view";
import type { CloudDocsBridge } from "@/app/lib/cloud-docs-types";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { openCloudDocTab } from "@/app/lib/cloud-doc-tabs";
import { uploadCloudFile } from "./upload-file";

type ApiRequest = {
  requestId: string;
  tenantId: string;
  op: "search" | "read" | "edit" | "create" | "import";
  params: Record<string, unknown>;
};

/**
 * 本地 Server 的云文档工具请求由主进程转到这里：按请求组织建立 product 视图并执行。
 * 请求使用原始工作区和会话身份，不读取当前界面选中的工作区。
 */
export function CloudDocsApiResponder({ client }: { client: JuggleWorkServerClient | null }) {
  React.useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    if (!bridge) return;
    const stopApi = bridge.onApiRequest((request: ApiRequest) => {
      void (async () => {
        try {
          if (request.op === "import") {
            if (!client) throw new Error("local_workspace_required");
            const outcome = await uploadCloudFile({
              bridge, fileClient: client, localWorkspaceId: String(request.params.localWorkspaceId ?? ""), relativePath: String(request.params.path), expectedTenantId: request.tenantId,
              onDuplicate: async () => "open",
            });
            if (!outcome) throw new Error("cloud_upload_cancelled");
            if (typeof request.params.sessionId === "string")
              openCloudDocTab(request.params.sessionId, { tenantId: request.tenantId, workspaceId: outcome.workspaceId, docId: outcome.pageId, title: String(request.params.path).split(/[\\/]/).pop() ?? "" });
            bridge.apiResponse({ requestId: request.requestId, ok: true, status: 200, body: { workspaceId: outcome.workspaceId, pageId: outcome.pageId, existing: outcome.status === "opened" } });
            return;
          }
          const op = request.op;
          const { sessionId: originSession, ...params } = request.params as { sessionId?: string } & Record<string, unknown>;
          // 搜索、链接校验和 AI 统一复用组织后台页，不以异常探测可用前台页。
          const result = await withProductView(bridge, request.tenantId, instanceId => bridge.api({ instanceId, requestId: crypto.randomUUID(), op, params }));
          const created = (result as { body: { workspaceId?: string; docId?: string } }).body;
          if (op === "create" && typeof originSession === "string" && created?.docId && created.workspaceId)
            openCloudDocTab(originSession, { tenantId: request.tenantId, workspaceId: created.workspaceId, docId: created.docId, title: String(params.title ?? "") });
          bridge.apiResponse({ requestId: request.requestId, ok: true, status: (result as { status: number }).status, body: (result as { body: unknown }).body });
        } catch (error) {
          bridge.apiResponse({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    return stopApi;
  }, [client]);
  return null;
}
