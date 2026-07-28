import type {
  JuggleWorkAffordanceDescriptor,
  JuggleWorkProviderRef,
} from "@jugglework/types/jugglework-affordance";
import type {
  JuggleWorkConversationLayout,
  JuggleWorkContextSnapshot,
  JuggleWorkPanelTab,
  JuggleWorkResourceDescriptor,
  JuggleWorkScreen,
} from "@jugglework/types/jugglework-context";

import type { PanelTabStore } from "../domains/session/panel/panel-tab-store";
import type { WorkbenchSnapshot } from "../domains/session/chat/workbench-store";
import type { UiState } from "./ui-state-store";

type JuggleWorkContextProjectorInput = {
  route: string;
  revision: number;
  capturedAt: string;
  workbench: WorkbenchSnapshot;
  ui: Pick<
    UiState,
    "sidebarOpen" | "sidePanelState" | "applicationMenuVisible" | "workspaceRightSidebarExpanded"
  >;
  panelSessions: PanelTabStore["sessions"];
  availableAffordances: JuggleWorkAffordanceDescriptor[];
};

function decoded(value: string | undefined) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function screenFromRoute(route: string): JuggleWorkScreen {
  const workspaceSettings = route.match(/^\/workspace\/([^/]+)\/settings(?:\/([^/?#]+))?/);
  if (workspaceSettings) {
    return {
      kind: "settings",
      route,
      workspaceId: decoded(workspaceSettings[1]),
      panel: decoded(workspaceSettings[2]) ?? "general",
    };
  }

  const settings = route.match(/^\/settings(?:\/([^/?#]+))?/);
  if (settings) {
    return {
      kind: "settings",
      route,
      panel: decoded(settings[1]) ?? "general",
    };
  }

  const workspaceSession = route.match(/^\/workspace\/([^/]+)\/session(?:\/([^/?#]+))?/);
  if (workspaceSession) {
    return {
      kind: "conversation",
      route,
      workspaceId: decoded(workspaceSession[1]),
      sessionId: decoded(workspaceSession[2]),
    };
  }

  const session = route.match(/^\/session(?:\/([^/?#]+))?/);
  if (session) {
    return {
      kind: "conversation",
      route,
      sessionId: decoded(session[1]),
    };
  }

  return { kind: "other", route };
}

function panelTab(tab: PanelTabStore["sessions"][string]["tabs"][number]): JuggleWorkPanelTab {
  if (tab.type === "browser") {
    return {
      id: tab.id,
      kind: "browser",
      label: tab.label,
      url: tab.url,
      status: tab.status,
    };
  }
  return {
    id: tab.id,
    kind: "artifact",
    label: tab.label,
  };
}

export function buildJuggleWorkContext(
  input: JuggleWorkContextProjectorInput,
): JuggleWorkContextSnapshot {
  const primarySessionId = input.workbench.primarySessionId;
  const splitSessionId = input.workbench.splitSessionId;
  const layout: JuggleWorkConversationLayout = primarySessionId && splitSessionId
    ? {
        kind: "split",
        primarySessionId,
        secondarySessionId: splitSessionId,
        focused: input.workbench.focusedPane,
      }
    : primarySessionId
      ? { kind: "single", sessionId: primarySessionId }
      : { kind: "empty" };

  const focusedSessionId = input.workbench.focusedPane === "secondary" && splitSessionId
    ? splitSessionId
    : primarySessionId;
  const panelOwnerSessionId = focusedSessionId && input.ui.sidePanelState[focusedSessionId]
    ? focusedSessionId
    : primarySessionId;
  const sessionPanelKind = panelOwnerSessionId
    ? input.ui.sidePanelState[panelOwnerSessionId] ?? null
    : null;
  const voiceOpen = Object.values(input.ui.sidePanelState).includes("voice");
  const sidePanelKind = voiceOpen ? "voice" : sessionPanelKind;
  const ownerSessionId = sidePanelKind === "voice" ? null : panelOwnerSessionId;
  const sessionPanel = ownerSessionId ? input.panelSessions[ownerSessionId] : undefined;
  const screen = screenFromRoute(input.route);
  const provider: JuggleWorkProviderRef = { id: "jugglework-ui", kind: "builtin" };
  const resources: JuggleWorkResourceDescriptor[] = [{
    ref: `screen:${input.route}`,
    kind: "screen",
    title: screen.kind === "settings" ? `${screen.panel} settings` : "JuggleWork",
    provider,
    state: { kind: screen.kind, route: input.route },
  }];
  if (input.workbench.workspaceId) {
    resources.push({
      ref: `workspace:${input.workbench.workspaceId}`,
      kind: "workspace",
      title: input.workbench.workspaceTitle ?? input.workbench.workspaceId,
      provider,
      state: { active: true },
    });
  }
  for (const tab of input.workbench.tabs) {
    const primary = tab.sessionId === primarySessionId;
    const secondary = tab.sessionId === splitSessionId;
    resources.push({
      ref: `session:${tab.sessionId}`,
      kind: "session",
      title: tab.title ?? tab.sessionId,
      provider,
      state: {
        workspaceId: tab.workspaceId,
        open: true,
        visible: primary || secondary,
        pane: primary ? "primary" : secondary ? "secondary" : null,
        focused: primary
          ? input.workbench.focusedPane === "primary"
          : secondary && input.workbench.focusedPane === "secondary",
      },
    });
  }
  if (screen.kind === "settings") {
    resources.push({
      ref: `settings:${screen.panel}`,
      kind: "settings",
      title: `${screen.panel} settings`,
      provider,
      state: { active: true, workspaceId: screen.workspaceId ?? null },
    });
  }
  if (sidePanelKind) {
    resources.push({
      ref: `side-panel:${ownerSessionId ?? "global"}`,
      kind: "side-panel",
      title: sidePanelKind,
      provider,
      state: {
        open: true,
        kind: sidePanelKind,
        ownerSessionId,
      },
    });
  }

  return {
    schemaVersion: 1,
    revision: input.revision,
    capturedAt: input.capturedAt,
    screen,
    conversations: {
      tabs: input.workbench.tabs,
      layout,
    },
    chrome: {
      sidebarOpen: input.ui.sidebarOpen,
      applicationMenuVisible: input.ui.applicationMenuVisible,
      rightSidebarExpanded: input.ui.workspaceRightSidebarExpanded,
    },
    execution: {
      queries: "parallel",
      commands: "serialized",
      busyCommandId: null,
      busyActor: null,
    },
    sidePanel: {
      open: sidePanelKind !== null,
      ownerSessionId,
      kind: sidePanelKind,
      tabs: sidePanelKind === "panel" ? (sessionPanel?.tabs ?? []).map(panelTab) : [],
      activeTabId: sidePanelKind === "panel" ? sessionPanel?.activeTabId ?? null : null,
    },
    resources,
    availableAffordances: input.availableAffordances,
    contributions: [],
  };
}
