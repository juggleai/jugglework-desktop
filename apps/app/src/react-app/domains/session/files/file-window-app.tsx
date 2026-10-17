import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FileText, FolderOpen, Plus, X } from "lucide-react";
import {
  FileEditorToolbar,
  getOfficeEditorStatus,
} from "./file-editor-toolbar";
import type { FileWindowState } from "@jugglework/types/file-window";
import {
  createJuggleWorkServerClient,
  type JuggleWorkServerClient,
} from "@/app/lib/jugglework-server";
import { Button } from "@/components/ui/button";
import { ArtifactIcon } from "@/components/chat/artifact-icon";
import { getArtifactType } from "@/lib/artifacts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { FileViewer } from "./file-viewer";
import { useFilesPanelStore } from "./files-panel-store";
import { saveSharedFileText } from "./shared-file-editor";
import { PreviewError, PreviewLoading } from "../artifacts/preview";

/** 独立文件窗口：原生标签栏、保存状态及文件操作；文档模型复用现有宿主。 */
export function FileWindowApp() {
  const bridge = window.__JUGGLEWORK_ELECTRON__?.fileWindow;
  const [state, setState] = React.useState<FileWindowState | null>(null);
  const [client, setClient] = React.useState<JuggleWorkServerClient | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!bridge) {
      setError(t("office.desktop_required"));
      return;
    }
    let cancelled = false;
    const stop = bridge.onChanged(setState);
    void bridge
      .state()
      .then((initial) => {
        if (cancelled) return;
        setState(initial);
        setClient(
          createJuggleWorkServerClient({
            baseUrl: initial.baseUrl,
            token: initial.token,
          }),
        );
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [bridge]);
  const active = state?.tabs.find((tab) => tab.path === state.activePath);
  const document = useQuery({
    queryKey: [
      "office-document",
      client?.baseUrl,
      state?.workspaceId,
      active?.documentId,
    ],
    enabled: Boolean(client && state && active?.documentId),
    queryFn: () =>
      client!.getOfficeDocument(state!.workspaceId, active!.documentId!),
    refetchInterval: 1000,
  }).data?.document;
  const action = async (
    name: Parameters<NonNullable<typeof bridge>["action"]>[0],
    path?: string,
  ) => {
    try {
      await bridge?.action(name, path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // TIPS: 输入法组合期间保留候选操作，不能触发宿主的打开或关闭动作。
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "w" && key !== "o") return;
      event.preventDefault();
      void action(
        key === "w" ? "close" : "open",
        key === "w" ? active?.path : undefined,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, active?.path]);
  const draft = useFilesPanelStore((store) =>
    state && active
      ? store.sessions[state.sessionId]?.drafts[active.path]
      : undefined,
  );
  const save = async () => {
    if (!client || !state || !active || active.readOnly) return;
    setBusy(true);
    try {
      if (!active.documentId) {
        if (draft)
          await saveSharedFileText(
            client,
            state.workspaceId,
            active.path,
            draft.content,
            draft.baseUpdatedAt,
          );
        return;
      }
      await client.saveOfficeDocument(state.workspaceId, active.documentId);
      await queryClient.invalidateQueries({
        queryKey: [
          "office-document",
          client.baseUrl,
          state.workspaceId,
          active.documentId,
        ],
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("office.save_failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="file-window-shell">
      <header
        className={`file-window-tabs ${state?.platform === "darwin" ? "is-mac" : ""}`}
      >
        <div
          className="file-window-tab-list"
          role="tablist"
          aria-label={t("file_window.files")}
        >
          {state?.tabs.map((tab) => (
            <div
              className={`file-window-tab ${tab.path === state.activePath ? "is-active" : ""}`}
              key={tab.path}
            >
              <button
                role="tab"
                aria-selected={tab.path === state.activePath}
                className="file-window-tab-select"
                onClick={() => void action("select", tab.path)}
                title={tab.name}
              >
                <ArtifactIcon
                  className="size-3.5 shrink-0"
                  type={getArtifactType(tab.name)}
                />
                <span>{tab.name}</span>
              </button>
              <button
                className="file-window-close"
                aria-label={`${t("common.close")} ${tab.name}`}
                onClick={() => void action("close", tab.path)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                className="file-window-add"
                variant="ghost"
                size="icon-sm"
                aria-label={t("file_window.add")}
              />
            }
          >
            <Plus className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuGroup>
              {!state?.local && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Plus />
                    {t("file_window.new")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => void action("create")}>
                      <FilePlus2 />
                      {t("file_window.word")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem onClick={() => void action("open")}>
                <FileText />
                {t("file_window.open")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {Boolean(state?.recent.length) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {t("file_window.recent")}
                  </DropdownMenuLabel>
                  {state?.recent.slice(0, 8).map((tab) => (
                    <DropdownMenuItem
                      key={tab.path}
                      onClick={() => void action("open", tab.path)}
                      title={tab.path}
                    >
                      <ArtifactIcon
                        className="size-3.5 shrink-0"
                        type={getArtifactType(tab.name)}
                      />
                      <span className="truncate">{tab.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="file-window-drag" />
        <img
          className="file-window-logo"
          src="./file-window-logo.png"
          alt="JuggleWork"
        />
      </header>
      {active && (
        <FileEditorToolbar
          officeDocumentId={active.documentId}
          name={active.name}
          status={
            active.readOnly
              ? "readonly"
              : active.documentId
                ? getOfficeEditorStatus(document, busy)
                : busy
                  ? "saving"
                  : draft
                    ? "unsaved"
                    : "saved"
          }
          saveDisabled={
            active.readOnly ||
            busy ||
            (active.documentId ? document?.state !== "ready" : !draft)
          }
          onSave={() => void save()}
          onReveal={() => void action("reveal")}
          onSaveCopy={() => void action("save-copy")}
          fileActionsDisabled={busy}
        />
      )}
      <main className="file-window-content">
        {error ? (
          <PreviewError message={error} />
        ) : !state || !client ? (
          <PreviewLoading />
        ) : active ? (
          <FileViewer
            key={active.path}
            client={client}
            workspaceId={state.workspaceId}
            sessionId={state.sessionId}
            path={active.path}
            name={active.name}
            draft={draft}
            hideOfficeHeader
          />
        ) : (
          <div className="file-window-empty">
            <img src="./file-window-logo.png" alt="" />
            <p>
              {t(state.local ? "file_window.empty_local" : "file_window.empty")}
            </p>
            <Button variant="outline" onClick={() => void action("open")}>
              <FolderOpen />
              {t("file_window.open")}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
