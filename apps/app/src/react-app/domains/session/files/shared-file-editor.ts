import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileEditorState } from "@jugglework/types/file-editor";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { toast } from "@/components/ui/sonner";
import { saveWorkspaceTextFile, type LoadedFile } from "./file-content";
import { useFilesPanelStore, type FilesPanelDraft } from "./files-panel-store";

/** 文件侧栏和文件浏览器共用草稿同步，网页环境保留现有本地编辑方式。 */
export function useSharedFileEditor(
  workspaceId: string,
  sessionId: string,
  path: string,
  fallback?: FilesPanelDraft,
) {
  const query = useQueryClient();
  const bridge =
    typeof window === "undefined"
      ? undefined
      : window.__JUGGLEWORK_ELECTRON__?.fileEditor;
  const draft =
    useFilesPanelStore((state) => state.sessions[sessionId]?.drafts[path]) ??
    fallback;
  React.useEffect(() => {
    if (!bridge) return;
    let changed = false;
    let disposed = false;
    const apply = (state: FileEditorState) => {
      if (disposed || state.workspaceId !== workspaceId || state.path !== path)
        return;
      useFilesPanelStore.getState().setDraft(sessionId, path, state.draft);
      useFilesPanelStore
        .getState()
        .setExternal(sessionId, path, state.external);
      if (state.saved)
        query.setQueryData<LoadedFile>(
          ["workspace-file", workspaceId, path],
          (current) =>
            current
              ? {
                  ...current,
                  text: state.saved!.content,
                  updatedAt: state.saved!.updatedAt,
                  size: state.saved!.size,
                }
              : current,
        );
    };
    const stop = bridge.onChanged((state) => {
      if (state.workspaceId === workspaceId && state.path === path) {
        changed = true;
        apply(state);
      }
    });
    const local =
      useFilesPanelStore.getState().sessions[sessionId]?.drafts[path] ??
      fallback;
    void bridge
      .state({ workspaceId, path })
      .then(async (state) => {
        if (disposed || changed) return;
        if (local && !state.draft && !state.saved && !state.external)
          apply(await bridge.update({ workspaceId, path }, local));
        else apply(state);
      })
      .catch((error) => toast.error(String(error)));
    return () => {
      disposed = true;
      stop();
    };
  }, [bridge, path, query, sessionId, workspaceId]);
  const setDraft = React.useCallback(
    (next: FilesPanelDraft | null) => {
      useFilesPanelStore.getState().setDraft(sessionId, path, next);
      void bridge
        ?.update({ workspaceId, path }, next)
        .catch((error) => toast.error(String(error)));
    },
    [bridge, path, sessionId, workspaceId],
  );
  return { draft, setDraft };
}

/** 保存共享草稿并返回实际落盘版本，供两种宿主使用同一保存状态。 */
export async function saveSharedFileText(
  client: JuggleWorkServerClient,
  workspaceId: string,
  path: string,
  content: string,
  baseUpdatedAt: number | null,
) {
  const bridge =
    typeof window === "undefined"
      ? undefined
      : window.__JUGGLEWORK_ELECTRON__?.fileEditor;
  if (bridge) {
    const state = await bridge.save({ workspaceId, path });
    if (!state.saved) throw new Error("没有可保存的文件修改");
    return { content: state.saved.content, updatedAt: state.saved.updatedAt };
  }
  return {
    content,
    updatedAt: await saveWorkspaceTextFile(
      client,
      workspaceId,
      path,
      content,
      baseUpdatedAt,
    ),
  };
}
