import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { useFilesPanelStore } from "@/react-app/domains/session/files/files-panel-store";
import { commitOfficeFileSwitch } from "@/react-app/domains/session/files/office-file-switch";

/** 会话文件面板里的云文档标签：只保存定位信息，按会话持久化。 */
export type CloudDocTab = { tenantId: string; workspaceId: string; docId: string; title: string };

export type CloudDocHighlight = { workspaceId: string; docId: string; blockIds: string[]; requestId: string };
type State = { tabs: CloudDocTab[]; active: string | null; highlight?: CloudDocHighlight };

const listeners = new Set<() => void>();
const cache = new Map<string, State>();
const empty: State = { tabs: [], active: null };
const storageKey = (sessionId: string) => `jugglework-cloud-doc-tabs:${sessionId}`;
const tabKey = (tab: Pick<CloudDocTab, "workspaceId" | "docId">) => `${tab.workspaceId}/${tab.docId}`;

function load(sessionId: string): State {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  let state = empty;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) || "null");
    if (Array.isArray(value?.tabs)) state = { tabs: value.tabs.slice(0, 12), active: null };
  } catch { /* 损坏的记录视为没有标签。 */ }
  cache.set(sessionId, state);
  return state;
}

function save(sessionId: string, state: State) {
  cache.set(sessionId, state);
  try { localStorage.setItem(storageKey(sessionId), JSON.stringify({ tabs: state.tabs })); } catch { /* 持久化失败不影响当前会话。 */ }
  listeners.forEach(listener => listener());
}

export const cloudDocTabsSnapshot = (sessionId: string) => load(sessionId);
export function subscribeCloudDocTabs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 打开（必要时新增）云文档标签并设为激活。 */
export function openCloudDocTab(sessionId: string, tab: CloudDocTab, blockIds?: string[]) {
  commitOfficeFileSwitch(sessionId, "", () => {
    const state = load(sessionId);
    const tabs = state.tabs.some(item => tabKey(item) === tabKey(tab)) ? state.tabs : [...state.tabs, tab];
    save(sessionId, { tabs, active: tabKey(tab), ...(blockIds ? { highlight: { workspaceId: tab.workspaceId, docId: tab.docId, blockIds, requestId: crypto.randomUUID() } } : {}) });
    useFilesPanelStore.getState().setActiveKey(sessionId, "cloud");
    useUiStateStore.getState().setSidePanelState(sessionId, "files");
  });
}

/** 选中同一排中的云文档；沿用 Office 选区切换检查，不重新加载已打开的页面。 */
export function activateCloudDocTab(sessionId: string, key: string | null) {
  commitOfficeFileSwitch(sessionId, "", () => {
    if (key && !load(sessionId).tabs.some(tab => tabKey(tab) === key)) return;
    save(sessionId, { ...load(sessionId), active: key });
    useFilesPanelStore.getState().setActiveKey(sessionId, key ? "cloud" : "files");
  });
}

/** 关闭云文档标签；当前文档关闭后选中相邻云文档，没有云文档时回到本地文件。 */
export function closeCloudDocTab(sessionId: string, key: string) {
  const state = load(sessionId);
  const index = state.tabs.findIndex(item => tabKey(item) === key);
  const tabs = state.tabs.filter(item => tabKey(item) !== key);
  const active = state.active === key ? (tabs[Math.min(index, tabs.length - 1)] ? tabKey(tabs[Math.min(index, tabs.length - 1)]) : null) : state.active;
  save(sessionId, { ...state, tabs, active });
  if (!active && useFilesPanelStore.getState().sessions[sessionId]?.activeKey === "cloud")
    useFilesPanelStore.getState().setActiveKey(sessionId, "files");
}

export { tabKey as cloudDocTabKey };
