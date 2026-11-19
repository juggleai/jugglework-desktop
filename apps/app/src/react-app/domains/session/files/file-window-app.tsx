import { FileCloudDocView } from "../../cloud-docs/file-cloud-doc-view";
import { CloudShareButton } from "../../cloud-docs/cloud-share-button";
import { canUploadToCloud } from "../../cloud-docs/upload-file";
import { OfficeCloudUploadButton } from "../office/office-cloud-upload-button";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, Plus, X, ArrowUpRight } from "lucide-react";
import {
  FileEditorToolbar,
  getOfficeEditorStatus,
} from "./file-editor-toolbar";
import type { FileWindowState, FileWindowConversationOptions } from "@jugglework/types/file-window";
import { FileWindowConversation, hasFileWindowConversation } from "./file-window-conversation";
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
import { isLanguage, t } from "@/i18n";
import { FileViewer } from "./file-viewer";
import { useFilesPanelStore } from "./files-panel-store";
import { saveSharedFileText } from "./shared-file-editor";
import { PreviewError, PreviewLoading } from "../artifacts/preview";
import { createOfficeFile } from "./office-create";
import { OfficeCreateItems } from "./office-create-items";
import { installOfficeComposerBridge } from "../surface/composer/office-composer-bridge";
import { activeFileWindowTab, fileWindowSourceKey, projectFileWindowSource } from "./file-window-source";

/** 独立文件窗口：原生标签栏、保存状态及文件操作；文档模型复用现有宿主。 */
export function FileWindowApp({ onAppearanceChange }: { onAppearanceChange?: (appearance: FileWindowState["appearance"]) => void }) {
  const bridge = window.__JUGGLEWORK_ELECTRON__?.fileWindow;
  const [state, setState] = React.useState<FileWindowState | null>(null);
  const [conversationOpen, setConversationOpen] = React.useState(false);
  const [conversationMounted, setConversationMounted] = React.useState(false);
  const [optionsBySource, setOptionsBySource] = React.useState<Record<string, FileWindowConversationOptions>>({});
  const active = activeFileWindowTab(state);
  const sourceKey = active ? fileWindowSourceKey(active.source) : "";
  const conversationOptions = optionsBySource[sourceKey] ?? state?.conversation;
  const changeConversationOptions = React.useCallback<React.Dispatch<React.SetStateAction<FileWindowConversationOptions>>>((update) => {
    setOptionsBySource((current) => ({ ...current, [sourceKey]: typeof update === "function" ? update(current[sourceKey] ?? conversationOptions ?? {}) : update }));
  }, [sourceKey, conversationOptions]);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const [conversationWidth, setConversationWidth] = React.useState(42);
  const contentRef = React.useRef<HTMLElement>(null);
  const canConverse = hasFileWindowConversation(state) && Boolean(bridge?.subscribeSessionEvents);
  const canRetryConversation = Boolean(active?.source.workspaceRoot && active.source.workspaceId && active.source.sessionId && active.source.sessionId !== "file-browser" && !active.source.workspaceId.startsWith("rem_") && bridge?.subscribeSessionEvents);
  const [retryingConversation, setRetryingConversation] = React.useState(false);
  const [client, setClient] = React.useState<JuggleWorkServerClient | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const queryClient = useQueryClient();
  const updateState = React.useCallback((next: FileWindowState) => {
    if (isLanguage(next.appearance?.lang) && (next.appearance?.theme === "light" || next.appearance?.theme === "dark")) {
      onAppearanceChange?.(next.appearance);
    }
    const projected = projectFileWindowSource(next);
    stateRef.current = projected;
    setState(projected);
    setOptionsBySource((current) => {
      const seeded = { ...current };
      for (const tab of next.tabs) {
        const key = fileWindowSourceKey(tab.source);
        if (tab.conversation && !seeded[key]) {
          const { model, agent, variant } = tab.conversation;
          seeded[key] = { model, agent, variant };
        }
      }
      return seeded;
    });
  }, [onAppearanceChange]);
  React.useEffect(() => {
    if (!bridge) {
      setError(t("office.desktop_required"));
      return;
    }
    let cancelled = false;
    const stop = bridge.onChanged((next) => { if (!cancelled) updateState(next); });
    void bridge
      .state()
      .then((initial) => {
        if (cancelled) return;
        updateState(initial);
        setClient(
          createJuggleWorkServerClient({
            baseUrl: initial.baseUrl,
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
  }, [bridge, updateState]);
  React.useEffect(() => {
    return installOfficeComposerBridge({
      scope: (input) => `file-window:${JSON.stringify([input.workspaceId, input.sessionId])}`,
      accept: (input) => Boolean(stateRef.current?.tabs.some((tab) => tab.source.workspaceId === input.workspaceId && tab.source.sessionId === input.sessionId)),
      preserveOnFileSwitch: (input) => {
        const source = activeFileWindowTab(stateRef.current)?.source;
        return Boolean(source && (source.workspaceId !== input.workspaceId || source.sessionId !== input.sessionId));
      },
      navigate: async (_path, input) => {
        const tab = stateRef.current?.tabs.find((tab) => tab.source.workspaceId === input.workspaceId && tab.source.sessionId === input.sessionId &&
          (tab.documentId === input.reference.documentId || tab.path === input.reference.preview.path));
        if (!tab || !bridge) throw new Error("选区不属于当前文件窗口");
        await bridge.action("select", tab.tabId);
        const next = projectFileWindowSource(await bridge.state());
        if (next.activeTabId !== tab.tabId) throw new Error("文件切换已取消");
        updateState(next);
        setConversationMounted(true); setConversationOpen(true);
      },
    });
  }, [bridge, updateState]);
  const openConversation = () => {
    setConversationMounted(true);
    setConversationOpen(true);
  };
  const retryConversation = async () => {
    if (!bridge || retryingConversation) return;
    setRetryingConversation(true);
    try {
      const next = await bridge.state();
      updateState(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingConversation(false);
    }
  };
  const resizeConversation = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (rect?.width) setConversationWidth(Math.min(65, Math.max(28, (rect.right - clientX) / rect.width * 100)));
  };
  const mediaReadOnly = active ? ["image", "video"].includes(getArtifactType(active.path)) : false;
  const document = useQuery({
    queryKey: [
      "office-document",
      client?.baseUrl,
      active?.source.workspaceId,
      active?.documentId,
    ],
    enabled: Boolean(client && state && active?.documentId),
    queryFn: () =>
      client!.getOfficeDocument(active!.source.workspaceId, active!.documentId!),
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
  const create = async (kind: "docx" | "pptx") => {
    if (!bridge || !state) return;
    try {
      await createOfficeFile(
        bridge,
        { workspaceId: state.workspaceId, sessionId: state.sessionId, kind },
        (file) => action("open", file.path),
      );
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
        key === "w" ? active?.tabId : undefined,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, active?.tabId]);
  const draft = useFilesPanelStore((store) =>
    active
      ? store.sessions[active.source.sessionId]?.drafts[active.path]
      : undefined,
  );
  const save = async () => {
    if (active?.cloudDoc) return;
    if (!client || !state || !active || active.readOnly) return;
    setBusy(true);
    try {
      if (!active.documentId) {
        if (draft)
          await saveSharedFileText(
            client,
            active.source.workspaceId,
            active.path,
            draft.content,
            draft.baseUpdatedAt,
          );
        return;
      }
      await client.saveOfficeDocument(active.source.workspaceId, active.documentId);
      await queryClient.invalidateQueries({
        queryKey: [
          "office-document",
          client.baseUrl,
          active.source.workspaceId,
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
              className={`file-window-tab ${tab.tabId === state.activeTabId ? "is-active" : ""}`}
              key={tab.tabId}
            >
              <button
                role="tab"
                aria-selected={tab.tabId === state.activeTabId}
                className="file-window-tab-select"
                onClick={() => void action("select", tab.tabId)}
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
                onClick={() => void action("close", tab.tabId)}
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
              {state?.group.kind === "conversation" && !state.local && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Plus />
                    {t("file_window.new")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <OfficeCreateItems onCreate={(kind) => void create(kind)} />
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
      <main ref={contentRef} className={`file-window-content ${canConverse && conversationOpen ? "has-conversation" : ""}`} style={{ "--conversation-width": `${conversationWidth}%` } as React.CSSProperties}>
      <section className="file-window-document">
      {active && !active.cloudDoc && (
        <FileEditorToolbar
          officeDocumentId={active.documentId}
          name={active.name}
          status={
            active.readOnly || mediaReadOnly
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
            active.readOnly || mediaReadOnly ||
            busy ||
            (active.documentId ? document?.state !== "ready" : !draft)
          }
          onSave={() => void save()}
          onReveal={() => void action("reveal", active.tabId)}
          onSaveCopy={() => void action("save-copy", active.tabId)}
          onUploadCloud={canUploadToCloud(active.name) && !active.cloudAttachment ? () => void (async () => { await save(); await action("upload-cloud", active.tabId); })() : undefined}
          fileActionsDisabled={busy}
          trailingActions={
            canConverse && !conversationOpen ? (
              <Button className="file-window-ai-entry" size="sm" aria-expanded={false} aria-controls="file-window-conversation" onClick={openConversation}>
                <img src="./jugglework-assistant.png" alt="" />
                {t("file_window.ai")}
              </Button>
            ) : !canConverse && canRetryConversation ? (
              <Button className="file-window-ai-entry" size="sm" disabled={retryingConversation} aria-label={`${t("file_window.ai")}: ${t("common.retry")}`} onClick={() => void retryConversation()}>
                <img src="./jugglework-assistant.png" alt="" />
                {t("file_window.ai")} · {t("common.retry")}
              </Button>
            ) : null
          }
        >
          {!active.cloudAttachment && canUploadToCloud(active.name) && <OfficeCloudUploadButton title={t("cloud_docs.upload")} onClick={() => void (async () => { await save(); await action("upload-cloud", active.tabId); })()} />}
          {!active.cloudAttachment && active.cloudUpload && <CloudShareButton onClick={() => void (async () => {
            try { await bridge?.action("share-cloud", active.tabId); toast.success(t("cloud_docs.link_copied")); }
            catch { toast.error(t("cloud_docs.copy_link_failed")); }
          })()} />}
          {active.cloudAttachment && <span className="text-xs text-muted-foreground">{t("cloud_docs.attachment_readonly")}</span>}
        </FileEditorToolbar>
      )}
      <div className="file-window-viewer" style={{ position: "relative" }}>
        {state?.tabs.filter(tab => tab.cloudDoc).map(tab => <FileCloudDocView key={tab.cloudDoc!.instanceId} tab={tab} sessionId={tab.source.sessionId} active={tab.tabId === state.activeTabId} appearance={state.appearance} />)}
        {error ? (
          <PreviewError message={error} />
        ) : !state || !client ? (
          <PreviewLoading />
        ) : active?.cloudDoc ? null : active ? (
          <FileViewer
            key={active.tabId}
            client={client}
            workspaceId={active.source.workspaceId}
            sessionId={active.source.sessionId}
            path={active.path}
            name={active.name}
            draft={draft}
            readOnly={active.readOnly}
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
      </div>
      </section>
      {canConverse && conversationOpen && <div
        className="file-window-separator" role="separator" tabIndex={0} aria-label={t("file_window.resize")} aria-orientation="vertical"
        aria-valuenow={conversationWidth} aria-valuemin={28} aria-valuemax={65}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setConversationWidth((width) => Math.min(65, Math.max(28, width + (event.key === "ArrowLeft" ? 2 : -2))));
        }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); resizeConversation(event.clientX); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeConversation(event.clientX); }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      />}
      {canConverse && conversationMounted && conversationOptions && state && client && bridge && <aside id="file-window-conversation" className="file-window-conversation" hidden={!conversationOpen}>
        <div className="file-window-conversation-header">
          <img className="file-window-assistant-icon" src="./jugglework-assistant.png" alt="" />
          <span className="file-window-conversation-title">JuggleWork</span>
          <Button className="file-window-open-session" variant="ghost" size="icon-sm" title={t("file_window.open_session")} aria-label={t("file_window.open_session")} onClick={() => void action("open-session", active?.tabId)}><ArrowUpRight className="size-4" /></Button>
          <Button className="file-window-close-conversation" variant="ghost" size="icon-sm" title={t("file_window.show_document")} aria-label={t("file_window.show_document")} onClick={() => setConversationOpen(false)}><X className="size-4" /></Button>
        </div>
        <div className="file-window-conversation-body">
          <FileWindowConversation key={sourceKey} state={state} client={client} bridge={bridge} visible={conversationOpen} options={conversationOptions} onOptionsChange={changeConversationOptions} />
        </div>
      </aside>}
      </main>
    </div>
  );
}
