import { CloudShareButton } from "./cloud-share-button";
import { installUploadedCloudFiles, uploadedCloudFiles, subscribeUploadedCloudFiles } from "./uploaded-files";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { OfficeCloudUploadButton } from "../session/office/office-cloud-upload-button";
import { lookupUploadedCloudFile, uploadCloudFile } from "./upload-file";

type Choice = "open" | "new" | "cancel";

/** 文件错误码到用户可读提示。 */
function describe(reason: string) {
  if (reason.includes("file_too_large") || reason.includes("blob_limit") || reason.includes("quota")) return t("cloud_docs.upload_too_large");
  if (reason.includes("unsupported_file_type") || reason.includes("invalid_file_content")) return t("cloud_docs.upload_unsupported");
  if (reason.includes("source_changed")) return t("cloud_docs.source_changed");
  if (reason.includes("organization_required")) return t("cloud_docs.enter_organization");
  return reason;
}

/**
 * 通用“上传云文档”：先 lookup 重复，再一次性上传；成功后 Toast 提供“查看云文档”，不自动跳转。
 * 返回 dialog 节点需渲染在调用方树内。
 */
export function useCloudUpload(client: JuggleWorkServerClient, localWorkspaceId: string) {
  const navigate = useNavigate();
  const [uploading, setUploading] = React.useState(false);
  const [duplicate, setDuplicate] = React.useState<{ resolve: (choice: Choice) => void } | null>(null);
  const running = React.useRef(false);
  const view = React.useCallback((tenantId: string, workspaceId: string, pageId: string) => {
    navigate(`/cloud-docs/${encodeURIComponent(tenantId)}?pageId=${encodeURIComponent(pageId)}&workspaceId=${encodeURIComponent(workspaceId)}`);
  }, [navigate]);
  const upload = React.useCallback(async (relativePath: string, prepare?: () => Promise<boolean>) => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    if (!bridge) { toast.error(t("cloud_docs.desktop_required")); return; }
    if (running.current) return;
    running.current = true;
    setUploading(true);
    try {
      // 保存失败、AI 运行中或选区待确认时不上传。
      if (prepare && !(await prepare())) return;
      const outcome = await uploadCloudFile({
        bridge, fileClient: client, localWorkspaceId, relativePath,
        onDuplicate: () => new Promise<Choice>(resolve => setDuplicate({ resolve })),
      });
      if (!outcome) return;
      if (outcome.status === "opened") { view(outcome.tenantId, outcome.workspaceId, outcome.pageId); return; }
      toast.success(t("cloud_docs.upload_done"), {
        description: outcome.warnings.length ? t("cloud_docs.upload_partial_format") : undefined,
        action: { label: t("cloud_docs.view_document"), onClick: () => view(outcome.tenantId, outcome.workspaceId, outcome.pageId) },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      toast.error(reason.includes("timeout") || reason.includes("result_unknown") ? t("cloud_docs.upload_pending") : t("cloud_docs.upload_failed"),
        { description: describe(reason) });
    } finally {
      running.current = false;
      setUploading(false);
    }
  }, [client, localWorkspaceId, view]);
  const settle = (choice: Choice) => { duplicate?.resolve(choice); setDuplicate(null); };
  const dialog = (
    <AlertDialog open={!!duplicate} onOpenChange={open => { if (!open) settle("cancel"); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("cloud_docs.duplicate_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("cloud_docs.duplicate_description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => settle("new")}>{t("cloud_docs.duplicate_save_new")}</Button>
          <Button onClick={() => settle("open")}>{t("cloud_docs.duplicate_open_existing")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { upload, uploading, dialog };
}

/** 顶栏“上传云文档”按钮；需要路由用于“查看云文档”，因此仅在主窗口路由内渲染。 */
export function CloudUploadButton({ client, localWorkspaceId, path, disabled, prepare }: {
  client: JuggleWorkServerClient;
  localWorkspaceId: string;
  path: string;
  disabled: boolean;
  prepare: () => Promise<boolean>;
}) {
  const { upload, uploading, dialog } = useCloudUpload(client, localWorkspaceId);
  const records = React.useSyncExternalStore(subscribeUploadedCloudFiles, uploadedCloudFiles);
  const uploaded = records.find(item => item.localWorkspaceId === localWorkspaceId && item.path === path);
  React.useEffect(installUploadedCloudFiles, []);
  React.useEffect(() => {
    if (!uploaded) void lookupUploadedCloudFile(client, localWorkspaceId, path).catch(() => undefined);
  }, [client, localWorkspaceId, path, uploaded]);
  const share = async () => {
    const current = uploadedCloudFiles().find(item => item.localWorkspaceId === localWorkspaceId && item.path === path);
    if (!current) return;
    try { await navigator.clipboard.writeText(current.url); toast.success(t("cloud_docs.link_copied")); }
    catch { toast.error(t("cloud_docs.copy_link_failed")); }
  };
  return (
    <>
      <OfficeCloudUploadButton
        busy={uploading}
        disabled={disabled || uploading}
        title={t(uploading ? "cloud_docs.uploading" : "cloud_docs.upload")}
        onClick={() => void upload(path, prepare)}
      />
      {uploaded && <CloudShareButton disabled={uploading} onClick={() => void share()} />}
      {dialog}
    </>
  );
}

const handledRequests = new Set<string>();
/** 独立文件窗口的上传请求由主窗口接手：按当前组织与该窗口的文件执行同一上传流程。 */
export function FileWindowUploadRelay({ client }: { client: JuggleWorkServerClient | null }) {
  const [requests, setRequests] = React.useState<Array<{ workspaceId: string; path: string; lookup?: boolean; requestId: string }>>([]);
  const request = requests[0];
  React.useEffect(() => {
    installUploadedCloudFiles();
    const receive = (input: { workspaceId: string; path: string; requestId?: string; lookup?: boolean }) => {
      if (input.requestId && handledRequests.has(input.requestId)) return;
      if (input.requestId) { handledRequests.add(input.requestId); if (handledRequests.size > 200) handledRequests.delete(handledRequests.values().next().value!); }
      setRequests(current => [...current, { ...input, requestId: input.requestId ?? crypto.randomUUID() }]);
    };
    const stop = window.__JUGGLEWORK_ELECTRON__?.fileWindow?.onUploadCloud?.(receive);
    const local = (event: Event) => receive((event as CustomEvent).detail);
    window.addEventListener("jugglework:upload-cloud", local);
    return () => { stop?.(); window.removeEventListener("jugglework:upload-cloud", local); };
  }, []);
  if (!client || !request) return null;
  return <RelayRun key={request.requestId} client={client} request={request} done={() => setRequests(current => current.slice(1))} />;
}

function RelayRun({ client, request, done }: { client: JuggleWorkServerClient; request: { workspaceId: string; path: string; lookup?: boolean }; done: () => void }) {
  const { upload, dialog } = useCloudUpload(client, request.workspaceId);
  React.useEffect(() => {
    if (request.lookup) void lookupUploadedCloudFile(client, request.workspaceId, request.path).catch(() => undefined).finally(done);
    else void upload(request.path).finally(done);
  }, []);
  return dialog;
}
