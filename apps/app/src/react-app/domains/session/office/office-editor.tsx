import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  computeBounds,
  hasNativeBrowserOccluder,
  sameBounds,
} from "../panel/utils";
import { useFilesPanelStore } from "../files/files-panel-store";
import {
  FileEditorToolbar,
  getOfficeEditorStatus,
} from "../files/file-editor-toolbar";
import { useArtifactActions } from "../artifacts/artifact-actions-provider";
import { JuggleWorkServerError } from "@/app/lib/jugglework-server";
import { loadWorkspaceFile } from "../files/file-content";
import { PreviewError, PreviewLoading } from "../artifacts/preview";

const WorkbookFileView = React.lazy(() =>
  import("../files/workbook-file-view").then((module) => ({
    default: module.WorkbookFileView,
  })),
);

/** 只读取原始工作簿，不建立可能丢失透视数据的原生模型。 */
function ReadonlyWorkbook({
  client,
  workspaceId,
  path,
}: {
  client: JuggleWorkServerClient;
  workspaceId: string;
  path: string;
}) {
  const file = useQuery({
    queryKey: ["workspace-file", client.baseUrl, workspaceId, path],
    queryFn: () => loadWorkspaceFile(client, workspaceId, path),
    retry: false,
    staleTime: 0,
  });
  if (file.isError) return <PreviewError message={String(file.error)} />;
  if (!file.data) return <PreviewLoading />;
  return (
    <React.Suspense fallback={<PreviewLoading />}>
      <WorkbookFileView bytes={file.data.bytes} />
    </React.Suspense>
  );
}

/**
 * 本地 Office 编辑容器，先挂载存活页面再等待原生模型 ready，按文件格式使用原生 Word、表格或幻灯片页面。
 * @param props 工作区、所属聊天与相对文件路径
 */
export function OfficeEditor({
  client,
  workspaceId,
  sessionId,
  path,
  hideHeader = false,
}: {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  path: string;
  hideHeader?: boolean;
}) {
  const queryClient = useQueryClient();
  const actions = useArtifactActions();
  const native =
    typeof window !== "undefined"
      ? window.__JUGGLEWORK_ELECTRON__?.office
      : undefined;
  const content = React.useRef<HTMLDivElement>(null);
  const [documentId, setDocumentId] = React.useState<string | null>(null);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const [readOnlyReason, setReadOnlyReason] = React.useState<string | null>(
    null,
  );
  const [saving, setSaving] = React.useState(false);
  const [recovering, setRecovering] = React.useState(false);
  const [detached, setDetached] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<string | null>(null);
  const claimed = React.useRef<string | null>(null);
  const external = useFilesPanelStore(
    (state) =>
      state.sessions[sessionId]?.externalPaths?.includes(path) ?? false,
  );
  const capabilities = useQuery({
    queryKey: ["office-capabilities", client.baseUrl, workspaceId],
    queryFn: () => client.officeCapabilities(workspaceId),
    retry: false,
    staleTime: 60_000,
  });
  const queryKey = React.useMemo(
    () => ["office-document", client.baseUrl, workspaceId, documentId],
    [client.baseUrl, workspaceId, documentId],
  );
  const query = useQuery({
    queryKey,
    enabled: Boolean(documentId),
    queryFn: () => client.getOfficeDocument(workspaceId, documentId!),
    retry: false,
    refetchInterval: (query) =>
      ["closed", "external", "error"].includes(
        query.state.data?.document.state ?? "",
      )
        ? false
        : 1000,
  });
  const document = query.data?.document;
  const updateDocument = React.useCallback(
    (next: OfficeDocumentSession) => {
      if (next.documentId !== documentId || next.workspaceId !== workspaceId)
        return;
      setOpenError(null);
      setSnapshot(null);
      claimed.current = null;
      queryClient.setQueryData(queryKey, { document: next });
    },
    [documentId, workspaceId, queryClient, queryKey],
  );
  React.useEffect(
    () => native?.onDocumentChanged?.(updateDocument),
    [native, updateDocument],
  );
  const recover = async () => {
    if (!native?.recover || !documentId) return;
    setRecovering(true);
    try {
      const next = await native.recover(workspaceId, documentId);
      if (next) updateDocument(next);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("office.open_failed"),
      );
    } finally {
      setRecovering(false);
    }
  };
  React.useEffect(() => {
    if (document?.state === "error") setSnapshot(null);
  }, [document?.state]);
  const activateHere = async () => {
    if (!native || !documentId || !content.current) return;
    const result = await native.show({
      workspaceId,
      documentId,
      bounds: computeBounds(content.current),
      activate: true,
    });
    if (result && result.here) {
      setDetached(false);
      setSnapshot(null);
    }
  };
  React.useEffect(() => {
    if (!native?.snapshot || !documentId || !detached) return;
    let stopped = false;
    const refresh = () =>
      void native.snapshot!(documentId)
        .then((image) => {
          if (!stopped && image) setSnapshot(image);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [native, documentId, detached]);

  React.useEffect(
    () =>
      native?.onLocation?.((location) => {
        if (location.documentId === documentId) setDetached(!location.here);
      }),
    [native, documentId],
  );

  React.useEffect(() => {
    if (
      native &&
      documentId &&
      ["external", "closed"].includes(document?.state ?? "")
    ) {
      void native.destroy(documentId);
    }
  }, [native, documentId, document?.state]);

  React.useEffect(() => {
    if (!capabilities.data?.available || !native || external) return;
    let cancelled = false;
    setDocumentId(null);
    setDetached(false);
    setOpenError(null);
    setReadOnlyReason(null);
    void client
      .openOfficeDocument(workspaceId, sessionId, path)
      .then(({ document }) => {
        if (cancelled) return;
        queryClient.setQueryData(
          ["office-document", client.baseUrl, workspaceId, document.documentId],
          { document },
        );
        setDocumentId(document.documentId);
      })
      .catch((error) => {
        if (cancelled) return;
        if (
          error instanceof JuggleWorkServerError &&
          error.code === "office_document_external"
        )
          useFilesPanelStore.getState().setExternal(sessionId, path, true);
        else if (
          error instanceof JuggleWorkServerError &&
          error.code === "office_readonly_required"
        )
          setReadOnlyReason(error.message);
        else
          setOpenError(
            error instanceof Error ? error.message : t("office.open_failed"),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    workspaceId,
    sessionId,
    path,
    capabilities.data?.available,
    native,
    queryClient,
    external,
  ]);

  React.useLayoutEffect(() => {
    const element = content.current;
    if (
      !native ||
      !element ||
      !documentId ||
      external ||
      detached ||
      !document?.previewUrl ||
      !["opening", "ready", "saving"].includes(document.state)
    )
      return;
    let cancelled = false;
    let frame = 0;
    let shown = false;
    let last: ReturnType<typeof computeBounds> | null = null;
    const watch = () => {
      if (cancelled) return;
      const bounds = computeBounds(element);
      const visible =
        bounds.width > 0 && bounds.height > 0 && !hasNativeBrowserOccluder();
      if (!visible && shown) {
        void native.hide(documentId, true).then((image) => {
          if (!cancelled && !shown && typeof image === "string")
            setSnapshot(image);
        });
        shown = false;
        last = null;
      } else if (visible && (!shown || !sameBounds(last, bounds))) {
        setSnapshot(null);
        shown = true;
        last = bounds;
        void native
          .show({
            workspaceId,
            documentId,
            bounds,
            activate:
              claimed.current !== documentId && globalThis.document.hasFocus(),
          })
          .then((result) => {
            if (!cancelled && result && !result.here) setDetached(true);
          })
          .catch((error) => {
            if (!cancelled)
              setOpenError(
                error instanceof Error
                  ? error.message
                  : t("office.open_failed"),
              );
          });
        claimed.current = documentId;
      }
      frame = window.requestAnimationFrame(watch);
    };
    watch();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      void native.hide(documentId);
    };
  }, [
    native,
    workspaceId,
    documentId,
    document?.previewUrl,
    document?.state,
    external,
    detached,
  ]);

  const save = async () => {
    if (!documentId) return;
    setSaving(true);
    try {
      const result = await client.saveOfficeDocument(workspaceId, documentId);
      queryClient.setQueryData(queryKey, result);
      await queryClient.invalidateQueries({
        queryKey: ["file-deliveries", client.baseUrl, workspaceId, sessionId],
      });
      toast.success(t("session_files.saved"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("office.save_failed"),
      );
    } finally {
      setSaving(false);
    }
  };
  const error =
    openError ??
    document?.error ??
    (query.isError ? String(query.error) : null);
  const externalView = external || document?.state === "external";
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-office-document={documentId ?? undefined}
    >
      {!hideHeader && (
        <FileEditorToolbar
          name={document?.name ?? path.split(/[\\/]/).pop() ?? path}
          status={
            readOnlyReason
              ? "readonly"
              : externalView
                ? "external"
                : getOfficeEditorStatus(document, saving)
          }
          saveDisabled={saving || externalView || document?.state !== "ready"}
          onSave={() => void save()}
          showFolderShortcut
          onReveal={
            actions?.desktop
              ? () => void actions.runPath("reveal", path)
              : undefined
          }
          onSaveCopy={
            actions?.desktop
              ? () => void actions.runPath("save-copy", path)
              : undefined
          }
          onOpenWindow={
            actions?.desktop && actions.fileWindowAvailable
              ? () => void actions.runPath("window", path)
              : undefined
          }
          fileActionsDisabled={saving || actions?.running}
          openWindowDisabled={false}
        >
          {externalView && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={async () => {
                if (!window.confirm(t("artifact.external_return_hint"))) return;
                try {
                  const result = await client.reopenOfficeDocument(
                    workspaceId,
                    sessionId,
                    path,
                  );
                  if (result.document.state === "error")
                    throw new Error(
                      result.document.error ?? t("office.open_failed"),
                    );
                  queryClient.setQueryData(
                    [
                      "office-document",
                      client.baseUrl,
                      workspaceId,
                      result.document.documentId,
                    ],
                    result,
                  );
                  setOpenError(null);
                  setDocumentId(result.document.documentId);
                  useFilesPanelStore
                    .getState()
                    .setExternal(sessionId, path, false);
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t("office.open_failed"),
                  );
                }
              }}
            >
              {t("artifact.reload_internal")}
            </Button>
          )}
        </FileEditorToolbar>
      )}
      <div ref={content} className="relative min-h-0 flex-1">
        {snapshot && !detached && (
          <img
            src={snapshot}
            alt=""
            className="pointer-events-none absolute inset-0 size-full"
          />
        )}
        {readOnlyReason ? (
          <div className="flex h-full min-h-0 flex-col" data-office-readonly>
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
              <p role="status" className="flex-1">
                {readOnlyReason}
              </p>
              {actions?.desktop && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void actions.runPath("external", path)}
                >
                  {t("artifact.open_external")}
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1">
              <ReadonlyWorkbook
                client={client}
                workspaceId={workspaceId}
                path={path}
              />
            </div>
          </div>
        ) : document?.state === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <p role="alert">{error ?? t("office.open_failed")}</p>
            {native?.recover && (
              <Button
                size="sm"
                variant="outline"
                disabled={recovering}
                onClick={() => void recover()}
              >
                {t(recovering ? "office.recovering" : "office.recover_saved")}
              </Button>
            )}
          </div>
        ) : detached ? (
          <button
            className="relative size-full cursor-text bg-muted/20"
            aria-label={t("office.activate_here")}
            onClick={() =>
              void activateHere().catch((error) => toast.error(String(error)))
            }
          >
            {snapshot ? (
              <img
                className="size-full object-contain object-top"
                src={snapshot}
                alt=""
              />
            ) : (
              <span>{t("office.loading")}</span>
            )}
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background/95 px-3 py-1 text-xs shadow-sm">
              {t("office.activate_here")}
            </span>
          </button>
        ) : externalView ||
          (!capabilities.isLoading &&
            (!capabilities.data?.available || !native)) ||
          error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {externalView
              ? t("artifact.external_active")
              : (error ??
                (!native
                  ? t("office.desktop_required")
                  : (capabilities.data?.reason ?? t("office.unavailable"))))}
          </div>
        ) : (
          document?.state !== "ready" &&
          document?.state !== "saving" && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("office.loading")}
            </div>
          )
        )}
      </div>
    </div>
  );
}
