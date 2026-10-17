import { getOfficeDocumentKind } from "@jugglework/types/office";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { JuggleWorkServerError } from "@/app/lib/jugglework-server";
import {
  joinDesktopPath,
  openDesktopPath,
  revealDesktopItemInDir,
  saveDesktopArtifactCopy,
} from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import type { ArtifactItem } from "@/lib/artifacts";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { saveWorkspaceTextFile } from "../files/file-content";
import { useFilesPanelStore } from "../files/files-panel-store";
import {
  getComposerDraft,
  getComposerMentions,
  useComposerStateStore,
} from "../surface/composer-state-store";
import { encodeComposerMentionValue } from "../surface/composer/mention-encoding";
import { requestComposerFocus } from "../surface/composer/focus-request";

/** 文件卡片与正文入口共用的已实现操作。 */
export type ArtifactAction =
  "reveal" | "external" | "attach" | "copy-path" | "save-copy" | "window";
type ArtifactActions = {
  desktop: boolean;
  running: boolean;
  fileWindowAvailable: boolean;
  run: (action: ArtifactAction, artifact: ArtifactItem) => Promise<void>;
  /** 已打开文件直接复用同一操作管线，不伪造交付产物。 */
  runPath: (action: ArtifactAction, path: string) => Promise<void>;
};
const ArtifactActionsContext = React.createContext<ArtifactActions | null>(
  null,
);

/**
 * 将已保存文件作为引用加入指定聊天草稿，去重且不发送消息。
 * @param sessionId 产物所属聊天
 * @param path 已确认的工作区相对路径
 */
export function addArtifactToComposer(sessionId: string, path: string): void {
  const store = useComposerStateStore.getState();
  const token = `@${encodeComposerMentionValue(path)}`;
  const draft = getComposerDraft(store, sessionId);
  store.setMentions(sessionId, {
    ...getComposerMentions(store, sessionId),
    [path]: "file",
  });
  if (!draft.split(/\s+/).includes(token)) {
    store.setDraft(
      sessionId,
      `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${token} `,
    );
  }
}

/**
 * 文件操作前保存主面板草稿；失败或取消不继续后续动作。
 * @param client 当前工作区服务端
 * @param workspaceId 工作区身份
 * @param sessionId 所属聊天
 * @param path 服务端确认的文件路径
 * @param confirmSave 询问用户是否保存后继续
 */
export async function prepareArtifactFileOperation(
  client: JuggleWorkServerClient,
  workspaceId: string,
  sessionId: string,
  path: string,
  confirmSave: () => boolean,
): Promise<boolean> {
  // TIPS: 原生 Office 的未保存内容属于引擎，不能用旧文本草稿覆盖磁盘文件。
  if (getOfficeDocumentKind(path)) return true;
  const shared =
    typeof window === "undefined"
      ? undefined
      : window.__JUGGLEWORK_ELECTRON__?.fileEditor;
  if (shared && !getOfficeDocumentKind(path))
    return shared.prepare({ workspaceId, path });
  const store = useFilesPanelStore.getState();
  const draft = store.sessions[sessionId]?.drafts[path];
  if (!draft) return true;
  if (!confirmSave()) return false;
  await saveWorkspaceTextFile(
    client,
    workspaceId,
    path,
    draft.content,
    draft.baseUpdatedAt,
  );
  // TIPS: 保存期间继续输入的新草稿不能被清空，也不能用刚保存的旧版本继续导出。
  if (
    useFilesPanelStore.getState().sessions[sessionId]?.drafts[path] !== draft
  ) {
    throw new Error(t("artifact.draft_changed"));
  }
  store.setDraft(sessionId, path, null);
  return true;
}

/**
 * 提供工作区与聊天明确绑定的文件操作，沿用既有桌面桥和草稿保存能力。
 * @param props 本地工作区、服务端、所属聊天及子组件
 */
export function ArtifactActionsProvider(props: {
  children: React.ReactNode;
  client: JuggleWorkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  remote: boolean;
  running?: boolean;
}) {
  const queryClient = useQueryClient();
  const desktop = !props.remote && isElectronRuntime();
  const [fileWindowAvailable, setFileWindowAvailable] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    const bridge = desktop
      ? window.__JUGGLEWORK_ELECTRON__?.fileWindow
      : undefined;
    // TIPS: Vite 能更新界面而不能更新已启动的 Electron，必须核对实际主进程能力。
    void (bridge?.available?.() ?? Promise.resolve(false))
      .then((available) => {
        if (active) setFileWindowAvailable(available);
      })
      .catch(() => {
        if (active) setFileWindowAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [desktop]);
  const running = props.running ?? false;
  const { client, workspaceId, workspaceRoot, sessionId } = props;
  const runPath = React.useCallback(
    async (action: ArtifactAction, path: string) => {
      try {
        if (action === "window" && !fileWindowAvailable)
          throw new Error(t("artifact.restart_desktop"));
        if (action !== "attach" && !desktop) return;
        if (["attach", "external", "save-copy", "window"].includes(action)) {
          if (running && !(action === "window" && getOfficeDocumentKind(path)))
            throw new Error(t("artifact.wait_for_task"));
          const sharedWindow =
            action === "window" &&
            Boolean(window.__JUGGLEWORK_ELECTRON__?.fileEditor);
          if (
            !sharedWindow &&
            !(await prepareArtifactFileOperation(
              client,
              workspaceId,
              sessionId,
              path,
              () => window.confirm(t("artifact.save_before_action")),
            ))
          )
            return;
          if (
            action !== "window" &&
            getOfficeDocumentKind(path) &&
            client.prepareOfficeFile
          ) {
            try {
              const prepared = await client.prepareOfficeFile(
                workspaceId,
                sessionId,
                path,
                action === "external",
              );
              if (action === "external" && prepared.document)
                await window.__JUGGLEWORK_ELECTRON__?.office?.destroy(
                  prepared.document.documentId,
                );
            } catch (error) {
              if (!(
                error instanceof JuggleWorkServerError && error.status === 404
              ))
                throw error;
            }
          }
          await queryClient.invalidateQueries({
            queryKey: ["workspace-file", workspaceId, path],
            exact: true,
          });
        }
        const info = await client.statWorkspaceFile(workspaceId, path);
        if (!info.exists || info.kind !== "file")
          throw new Error(t("artifact.file_missing"));
        if (action === "window") {
          await window.__JUGGLEWORK_ELECTRON__?.fileWindow?.open({
            workspaceId,
            sessionId,
            path,
          });
          return;
        }
        if (action === "attach") {
          addArtifactToComposer(sessionId, path);
          requestComposerFocus(sessionId, "control");
          toast.success(t("artifact.added_to_chat"));
          return;
        }
        const absolutePath = await joinDesktopPath(workspaceRoot, path);
        if (action === "copy-path") {
          await navigator.clipboard.writeText(absolutePath);
          toast.success(t("session_files.path_copied"));
        } else if (action === "reveal") {
          await revealDesktopItemInDir(absolutePath);
        } else if (action === "external") {
          // TIPS: Office 已保存并释放原模型，外部打开失败也保留接管状态，避免过期模型覆写文件。
          useFilesPanelStore.getState().setExternal(sessionId, path, true);
          if (!getOfficeDocumentKind(path))
            await window.__JUGGLEWORK_ELECTRON__?.fileEditor?.external(
              { workspaceId, path },
              true,
            );
          try {
            await openDesktopPath(absolutePath);
          } catch (cause) {
            if (!getOfficeDocumentKind(path))
              useFilesPanelStore.getState().setExternal(sessionId, path, false);
            if (!getOfficeDocumentKind(path))
              await window.__JUGGLEWORK_ELECTRON__?.fileEditor?.external(
                { workspaceId, path },
                false,
              );
            throw cause;
          }
        } else if (action === "save-copy") {
          const result = await saveDesktopArtifactCopy(
            workspaceRoot,
            path,
            t("artifact.save_copy"),
          );
          if (result)
            toast.success(t("artifact.copy_saved"), { description: result });
        }
      } catch (cause) {
        toast.error(
          cause instanceof Error
            ? cause.message
            : t("artifact.operation_failed"),
        );
      }
    },
    [
      client,
      desktop,
      fileWindowAvailable,
      queryClient,
      running,
      sessionId,
      workspaceId,
      workspaceRoot,
    ],
  );
  const value = React.useMemo(
    () => ({
      desktop,
      running,
      fileWindowAvailable,
      runPath,
      run: (action: ArtifactAction, artifact: ArtifactItem) =>
        runPath(action, artifact.legacy_target.value),
    }),
    [desktop, running, fileWindowAvailable, runPath],
  );
  return (
    <ArtifactActionsContext.Provider value={value}>
      {props.children}
    </ArtifactActionsContext.Provider>
  );
}

/** 读取所属聊天的文件操作，缺少宿主时由界面禁用原生动作。 */
export function useArtifactActions() {
  return React.useContext(ArtifactActionsContext);
}
