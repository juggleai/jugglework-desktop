import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const PERSISTED_FILES_PANEL_STORE_KEY = "jugglework:files-panel:v1";

/**
 * 文件面板内容区当前展示的内容
 *
 * - `files`：打开的文件
 * - `changes`：当前会话累计产生的文件改动（以「变更」标签的形式出现在标签栏里）
 */
export type FilesPanelTabKey = "files" | "changes";

/**
 * 文件面板中打开的一个文件标签
 *
 * @param path 工作区相对路径，同时作为标签唯一 id
 * @param name 文件名，用于标签展示
 */
export type FilesPanelFileTab = {
  path: string;
  name: string;
};

/**
 * 未保存草稿
 *
 * @param content 编辑器中的最新文本
 * @param baseUpdatedAt 打开该文件时服务端返回的 mtime，用于保存时的乐观并发校验
 */
export type FilesPanelDraft = {
  content: string;
  baseUpdatedAt: number | null;
};

type FilesPanelSessionState = {
  activeKey: FilesPanelTabKey;
  tabs: FilesPanelFileTab[];
  activePath: string | null;
  expandedDirs: string[];
  fullscreen: boolean;
  treeCollapsed: boolean;
  selectedChangePath: string | null;
  drafts: Record<string, FilesPanelDraft>;
};

const EMPTY_SESSION: FilesPanelSessionState = {
  activeKey: "files",
  tabs: [],
  activePath: null,
  expandedDirs: [],
  fullscreen: false,
  treeCollapsed: false,
  selectedChangePath: null,
  drafts: {},
};

export type FilesPanelStore = {
  sessions: Record<string, FilesPanelSessionState>;
  setActiveKey: (sessionId: string, key: FilesPanelTabKey) => void;
  openFile: (sessionId: string, tab: FilesPanelFileTab) => void;
  closeFile: (sessionId: string, path: string) => void;
  selectFile: (sessionId: string, path: string) => void;
  toggleDir: (sessionId: string, path: string) => void;
  setFullscreen: (sessionId: string, fullscreen: boolean) => void;
  toggleFullscreen: (sessionId: string) => void;
  toggleTreeCollapsed: (sessionId: string) => void;
  selectChange: (sessionId: string, path: string | null) => void;
  setDraft: (sessionId: string, path: string, draft: FilesPanelDraft | null) => void;
  clearSession: (sessionId: string) => void;
};

function readSession(state: FilesPanelStore, sessionId: string): FilesPanelSessionState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}

function writeSession(
  state: FilesPanelStore,
  sessionId: string,
  session: FilesPanelSessionState,
): Partial<FilesPanelStore> {
  return { sessions: { ...state.sessions, [sessionId]: session } };
}

/**
 * 文件面板状态
 *
 * TIPS: 全屏与分栏是 React 树里的两个不同挂载点，切换时面板组件必然重挂载。
 * 因此标签、展开目录、草稿等全部状态都放在这里，重挂载后原样恢复；
 * 草稿只存在内存中（partialize 不落盘），避免把大文件写进 localStorage。
 */
export const useFilesPanelStore = create<FilesPanelStore>()(
  persist(
    (set) => ({
      sessions: {},

      setActiveKey: (sessionId, key) =>
        set((state) => writeSession(state, sessionId, { ...readSession(state, sessionId), activeKey: key })),

      openFile: (sessionId, tab) =>
        set((state) => {
          const session = readSession(state, sessionId);
          const exists = session.tabs.some((item) => item.path === tab.path);

          return writeSession(state, sessionId, {
            ...session,
            activeKey: "files",
            tabs: exists ? session.tabs : [...session.tabs, tab],
            activePath: tab.path,
          });
        }),

      closeFile: (sessionId, path) =>
        set((state) => {
          const session = readSession(state, sessionId);
          const index = session.tabs.findIndex((item) => item.path === path);

          if (index === -1) return {};

          const tabs = session.tabs.filter((item) => item.path !== path);
          const drafts = { ...session.drafts };

          delete drafts[path];

          const activePath = session.activePath === path
            ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null
            : session.activePath;

          return writeSession(state, sessionId, { ...session, tabs, activePath, drafts });
        }),

      selectFile: (sessionId, path) =>
        set((state) => writeSession(state, sessionId, {
          ...readSession(state, sessionId),
          activeKey: "files",
          activePath: path,
        })),

      toggleDir: (sessionId, path) =>
        set((state) => {
          const session = readSession(state, sessionId);
          const expanded = new Set(session.expandedDirs);

          if (expanded.has(path)) expanded.delete(path);
          else expanded.add(path);

          return writeSession(state, sessionId, { ...session, expandedDirs: [...expanded] });
        }),

      setFullscreen: (sessionId, fullscreen) =>
        set((state) => writeSession(state, sessionId, { ...readSession(state, sessionId), fullscreen })),

      toggleFullscreen: (sessionId) =>
        set((state) => {
          const session = readSession(state, sessionId);

          return writeSession(state, sessionId, { ...session, fullscreen: !session.fullscreen });
        }),

      toggleTreeCollapsed: (sessionId) =>
        set((state) => {
          const session = readSession(state, sessionId);

          return writeSession(state, sessionId, { ...session, treeCollapsed: !session.treeCollapsed });
        }),

      selectChange: (sessionId, path) =>
        set((state) => writeSession(state, sessionId, { ...readSession(state, sessionId), selectedChangePath: path })),

      setDraft: (sessionId, path, draft) =>
        set((state) => {
          const session = readSession(state, sessionId);
          const drafts = { ...session.drafts };

          if (draft) drafts[path] = draft;
          else delete drafts[path];

          return writeSession(state, sessionId, { ...session, drafts });
        }),

      clearSession: (sessionId) =>
        set((state) => {
          if (!state.sessions[sessionId]) return {};

          const sessions = { ...state.sessions };

          delete sessions[sessionId];

          return { sessions };
        }),
    }),
    {
      name: PERSISTED_FILES_PANEL_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => [
            sessionId,
            { ...session, drafts: {} },
          ]),
        ),
      }),
    },
  ),
);

/**
 * 读取某个会话的文件面板状态（未初始化时返回稳定的空态引用）
 *
 * @param sessionId 会话 id
 */
export function useFilesPanelSession(sessionId: string): FilesPanelSessionState {
  return useFilesPanelStore((state) => state.sessions[sessionId] ?? EMPTY_SESSION);
}

/**
 * 读取某个会话的全屏状态
 *
 * @param sessionId 会话 id
 */
export function useFilesPanelFullscreen(sessionId: string | null | undefined): boolean {
  return useFilesPanelStore((state) => (sessionId ? state.sessions[sessionId]?.fullscreen ?? false : false));
}
