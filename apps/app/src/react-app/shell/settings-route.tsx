/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "@/components/ui/sonner";

import { SUGGESTED_PLUGINS } from "@/app/constants";
import type { EnablementContext } from "@/app/enablement";
import { createClient, unwrap } from "@/app/lib/opencode";
import {
  createJuggleWorkServerClient,
  isLoopbackJuggleWorkServerUrl,
  readJuggleWorkServerSettings,
  JuggleWorkServerError,
  type JuggleWorkCloudMcpHealth,
  type JuggleWorkCloudMcpProviderModelContext,
  type JuggleWorkServerCapabilities,
  type JuggleWorkServerClient,
  type JuggleWorkWorkspaceInfo,
} from "@/app/lib/jugglework-server";
import { buildJuggleWorkEnvRuntimeKey } from "@/app/lib/jugglework-env-runtime";
import {
  collectAgentContextDiagnosticObservations,
  isAgentContextDiagnosticsWorkspaceAllowed,
  resolveOrganizationConnectionsProbe,
} from "@/app/lib/agent-context-diagnostics";
import {
  getInitialThemeMode,
  setThemeMode as setAppThemeMode,
  type ThemeMode,
} from "@/app/theme";
import type {
  Client,
  ProviderListItem,
  SettingsTab,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspacePreset,
  WorkspaceSessionGroup,
} from "@/app/types";
import { getWorkspaceTaskLoadErrorDisplay } from "@/app/utils";
import { currentLocale, t, setLocale, type Language } from "@/i18n";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  describeWorkspaceCreateError,
  downloadWorkspaceJson,
  folderNameFromPath,
  getSessionStatus,
  isActiveSessionStatus,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "@/react-app/domains/connections/store";
import { cleanupJuggleWorkCloudMcpAfterSignOut } from "@/react-app/domains/connections/cloud-mcp-reconciler";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import { createJuggleWorkServerStore, useJuggleWorkServerStoreSnapshot } from "@/react-app/domains/connections/jugglework-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "@/react-app/domains/connections/provider-auth/store";
import { getCurrentCloudManagedProviderIds } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import {
  customProviderInputFromProvider,
  type CustomProviderInput,
} from "@/react-app/domains/connections/provider-auth/custom-provider-config";
import ConnectionsModals from "@/react-app/domains/connections/modals";
import { AiSettingsView } from "@/react-app/domains/settings/pages/ai-view";
// Side-effect imports: register extension config components into the registry.
import "@/react-app/domains/settings/ollama-config";
import "@/react-app/domains/settings/computer-use-config";
import "@/react-app/domains/settings/browser-extension-config";
import "@/react-app/domains/settings/jugglework-voice-config";
import "@/react-app/domains/settings/google-workspace-config";
import { useSettingsExtensionController } from "@/react-app/domains/settings/settings-extension-controller";
import { buildExtensionItems } from "@/react-app/domains/settings/extension-items";
import { isJuggleWorkExtensionEnabled, JUGGLEWORK_EXTENSION_STATE_CHANGED } from "@/react-app/domains/settings/extension-state";
import { PreferencesView } from "@/react-app/domains/settings/pages/preferences-view";
import { ShellCustomizationView } from "@/react-app/domains/settings/pages/shell-view";
import { GeneralSettingsView } from "@/react-app/domains/settings/pages/general-view";
import { AuthorizedFoldersPanel } from "@/react-app/domains/settings/panels/authorized-folders-panel";
import { SettingsStack } from "@/react-app/domains/settings/settings-section";
import { AdvancedView } from "@/react-app/domains/settings/pages/advanced-view";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import { CloudAccountView } from "@/react-app/domains/settings/pages/cloud-account-view";
import { ConnectView } from "@/react-app/domains/settings/pages/connect-view";
import {
  EMPTY_CONNECT_CAPABILITY_INVENTORY,
  listAssignedConnectCapabilities,
  type ConnectCapabilityInventory,
} from "@/react-app/domains/session/surface/connect-capability-inventory";
import { createOpaqueDiagnosticsScopeKey } from "@/react-app/domains/settings/pages/agent-context-diagnostics-section";
import { CloudProvidersView } from "@/react-app/domains/settings/pages/cloud-providers-view";
import { MemoryView } from "@/react-app/domains/settings/pages/memory-view";
import { useFeatureFlagsPreferences } from "@/react-app/domains/settings/state/feature-flags-preferences";
import {
  readGlobalAutoCompaction,
  writeGlobalAutoCompaction,
} from "@/react-app/domains/settings/state/global-compaction-preference";
import type { GlobalConfigTarget } from "@/react-app/domains/settings/state/global-opencode-config";
import {
  readGlobalMcpEntries,
  removeGlobalMcp,
  setGlobalMcpEnabled,
  upsertGlobalMcp,
  type GlobalMcpEntry,
} from "@/react-app/domains/settings/state/global-mcp-config";
import { GlobalSkillsView } from "@/react-app/domains/settings/pages/global-skills-view";
import {
  GlobalConnectorsView,
  type GlobalConnectorItem,
} from "@/react-app/domains/settings/pages/global-connectors-view";
import { DebugView } from "@/react-app/domains/settings/pages/debug-view";
import { EnvironmentView } from "@/react-app/domains/settings/pages/environment-view";
import { ExtensionsView } from "@/react-app/domains/settings/pages/extensions-view";
import { CloudMarketplacesView } from "@/react-app/domains/settings/pages/cloud-marketplaces-view";
import { McpView } from "@/react-app/domains/settings/pages/mcp-view";
import { ProjectExtensionsPanel } from "@/react-app/domains/settings/pages/project-extensions/project-extensions-panel";
import { buildProjectConnectors } from "@/react-app/domains/settings/pages/project-extensions/connectors-source";
import { RecoveryView } from "@/react-app/domains/settings/pages/recovery-view";
import { UpdatesView } from "@/react-app/domains/settings/pages/updates-view";
import { NotificationCenterView } from "@/react-app/shell/notification-center";
import { useDebugViewModel } from "@/react-app/domains/settings/state/debug-view-model";
import { useElectronUpdaterState } from "@/react-app/domains/settings/state/electron-updater-state";
import { CloudSessionProvider, useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import { useControlAction, type JuggleWorkControlAction } from "./control/control-provider";
import { useBootState } from "./boot-state";
import { SettingsShell } from "@/react-app/domains/settings/shell/settings-shell";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "@/react-app/domains/settings/state/extensions-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  juggleworkServerInfo,
  juggleworkServerRestart,
  engineStart,
  engineRestart,
  pickDirectory,
  importSkill,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreateRemote,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  desktopBridge,
  type WorkspaceInfo,
  type WorkspaceList,
  revealDesktopItemInDir,
} from "@/app/lib/desktop";
import { isDesktopProviderBlocked, isProviderHiddenFromConnectUi } from "@/app/cloud/desktop-app-restrictions";
import {
  useCheckDesktopRestriction,
  useDesktopAllowedModels,
  useDesktopConfig,
} from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import {
  isDesktopRuntime,
  isElectronRuntime,
  isMacPlatform,
  normalizeDirectoryPath,
  resolveModelDisplayName,
  resolveProviderDisplayName,
  safeStringify,
} from "@/app/utils";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import type { CreateWorkspaceScreen } from "@/react-app/domains/workspace/types";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { ShareWorkspaceModal } from "@/react-app/domains/workspace/share-workspace-modal";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal";
import type { McpServerConfig, ModelRef } from "@/app/types";
import { workspaceSwatchColor } from "@/react-app/domains/session/sidebar/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import { ensureDesktopLocalJuggleWorkConnection } from "./desktop-local-jugglework";
import { resolveJuggleWorkConnection } from "./jugglework-connection";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { notifyAlert } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";
import { CommandPalette } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import { useCommandPaletteShortcut } from "./use-shell-shortcuts";
import { type DenSettings } from "@/app/lib/den";
import { readActiveWorkspaceId, readLastSessionFor, writeActiveWorkspaceId } from "./session-memory";
import { settingsReturnRoute, workspaceAppsRoute, workspaceChatRoute, workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import {
  createWorkspaceServerClientResolver,
  useWorkspaceServerClient,
} from "@/react-app/infra/workspace-server-client";
import {
  buildLocalProviderConfig,
  OPENAI_IMAGE_EXTENSION_ID,
  OPENAI_IMAGE_MODEL,
  type LocalProviderInstallInput,
} from "@/react-app/domains/settings/openai-image-extension";

const ROUTE_JUGGLEWORK_CAPABILITIES: JuggleWorkServerCapabilities = {
  skills: { read: true, write: true, source: "jugglework" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

async function reloadEngineOrRestartDesktop(
  client: Pick<JuggleWorkServerClient, "reloadEngine">,
  workspaceId: string,
  afterRestart?: () => Promise<void>,
): Promise<void> {
  try {
    await client.reloadEngine(workspaceId);
  } catch (error) {
    const unreachable =
      error instanceof JuggleWorkServerError && error.code === "opencode_engine_unreachable";
    if (!unreachable || !isDesktopRuntime()) {
      throw error;
    }
    await engineRestart({});
    await afterRestart?.();
  }
}

function normalizeComputerUsePermissions(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  return {
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
  };
}

function reconcileSelectedWorkspaceId(
  currentId: string,
  serverList: { activeId?: string | null },
  desktopList: WorkspaceList | null,
  workspaces: RouteWorkspace[],
) {
  const current = currentId.trim();
  const serverIds = new Set(workspaces.map((workspace) => workspace.id));
  if (current && serverIds.has(current)) return current;

  const desktopSelectedId = resolveWorkspaceListSelectedId(desktopList);
  const desktopSelected = desktopSelectedId
    ? desktopList?.workspaces?.find((workspace) => workspace.id === desktopSelectedId)
    : null;
  const currentDesktop = current
    ? desktopList?.workspaces?.find((workspace) => workspace.id === current)
    : null;
  const selectedPath = normalizeDirectoryPath((currentDesktop ?? desktopSelected)?.path ?? "");

  if (selectedPath) {
    const pathMatch = workspaces.find(
      (workspace) => normalizeDirectoryPath(workspace.path ?? "") === selectedPath,
    );
    if (pathMatch) return pathMatch.id;
  }

  return serverList.activeId?.trim() || desktopSelectedId || workspaces[0]?.id || "";
}

const SETTINGS_HIDE_TITLEBAR_KEY = "jugglework.react.settings.hide-titlebar";
const SETTINGS_UPDATE_AUTO_CHECK_KEY = "jugglework.react.settings.update-auto-check";
const SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY = "jugglework.react.settings.update-auto-download";

export function parseSettingsPath(pathname: string): {
  tab: SettingsTab;
  redirectPath: string | null;
  extensionsSection?: "all" | "mcp" | "plugins";
} {
  const trimmed = pathname
    .replace(/^\/workspace\/[^/]+\/settings\/?/, "")
    .replace(/^\/settings\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return { tab: "preferences", redirectPath: "preferences" };
  }

  const [head, tail] = trimmed.split("/");
  switch (head) {
    case "notifications":
      return { tab: head, redirectPath: null };
    case "general":
      return { tab: "preferences", redirectPath: "preferences" };
    case "ai":
    case "preferences":
    case "permissions":
    case "shell":
    case "advanced":
    case "appearance":
    case "environment":
    case "updates":
    case "recovery":
    case "debug":
    // 全局技能与全局连接器，与工作区级的 `extensions` 是两个不同的页面。
    case "skills":
    case "connectors":
      return { tab: head, redirectPath: null };
    case "cloud-account":
    case "connect":
    case "cloud-providers":
    case "memory":
      return { tab: head, redirectPath: null };
    case "cloud-marketplaces":
      return { tab: "extensions", redirectPath: "extensions", extensionsSection: "all" };
    case "den":
    case "cloud-workers":
      return { tab: "cloud-account", redirectPath: "cloud-account" };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: null, extensionsSection: "mcp" };
      if (tail === "skills") return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
      if (tail === "plugins") return { tab: "extensions", redirectPath: null, extensionsSection: "plugins" };
      return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
    default:
      return { tab: "preferences", redirectPath: "preferences" };
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore persistence failures
  }
}

function readNavigationWorkspaceId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" ? value.trim() || null : null;
}

function readNavigationSessionId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { sessionId?: unknown }).sessionId;
  return typeof value === "string" ? value.trim() || null : null;
}

function readNavigationReturnPath(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { returnPath?: unknown }).returnPath;
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

function findSessionWorkspaceId(
  sessionId: string | null,
  entries: Array<{ workspaceId: string; sessions: any[] }>,
) {
  const id = sessionId?.trim();
  if (!id) return null;
  return entries.find((entry) => entry.sessions.some((session) => session?.id === id))?.workspaceId ?? null;
}

function settingsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.tab === "extensions" && route.extensionsSection && route.extensionsSection !== "all") {
    return `extensions/${route.extensionsSection}`;
  }
  return route.tab;
}

export type SettingsSurfaceProps = {
  embedded?: boolean;
  contentOnly?: boolean;
  initialPath?: string;
  /** Keep parsing the retained settings route while this surface is hidden behind another app module. */
  routePath?: string;
  /**
   * Whether this surface currently owns the browser route. Defaults to true.
   *
   * TIPS: 设置面板是常驻挂载的，被会话页盖住时也在渲染。它的两处规范化重定向走的是全局
   * 路由（`<Navigate replace>`），隐藏时若照样执行，就会在启动阶段把整个 app 的 URL 抢到
   * `/settings/preferences` —— 表现为冷启动首屏是设置页而不是本地工作区。隐藏态下必须
   * 只解析路由、不改路由。
   */
  active?: boolean;
  workspaceId?: string;
  onClose?: () => void;
};

function SettingsRouteContent(props: SettingsSurfaceProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const routeWorkspaceId = props.workspaceId?.trim() || params.workspaceId?.trim() || "";
  const local = useLocal();
  const { memoryEnabled, toggleMemory } = useFeatureFlagsPreferences();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const allowedModels = useDesktopAllowedModels();
  const restrictionNotice = useRestrictionNotice();
  const desktopConfig = useDesktopConfig();
  const reloadCoordinator = useReloadCoordinator();
  const [embeddedPath, setEmbeddedPath] = useState(props.initialPath ?? "preferences");
  const route = props.embedded
    ? parseSettingsPath(`/settings/${embeddedPath}`)
    : parseSettingsPath(props.routePath ?? location.pathname);
  const navigationWorkspaceId = readNavigationWorkspaceId(location.state);
  const navigationSessionId = readNavigationSessionId(location.state);
  const navigationReturnPath = readNavigationReturnPath(location.state);

  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, RouteSession[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState(() => navigationWorkspaceId ?? readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;

  useEffect(() => {
    if (!props.embedded || !route.redirectPath) return;
    setEmbeddedPath(route.redirectPath);
  }, [props.embedded, route.redirectPath]);

  const navigateSettingsPath = useCallback((path: string) => {
    if (props.embedded) {
      setEmbeddedPath(path);
      return;
    }
    navigate(
      selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, path) : `/settings/${path}`,
      { state: location.state },
    );
  }, [location.state, navigate, props.embedded, selectedWorkspaceId]);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [hostToken, setHostToken] = useState("");
  const [juggleworkClient, setJuggleWorkClient] = useState<JuggleWorkServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const refreshInFlightRef = useRef(false);
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const refreshMcpServersRef = useRef<(() => void | Promise<void>) | null>(null);
  const notifyMcpReloadingRef = useRef<(() => void) | null>(null);
  const pollMcpServersAfterReloadRef = useRef<(() => void | Promise<void>) | null>(null);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const providerDisplayCacheRef = useRef(new Map<string, ProviderListItem>());
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("jugglework.developerMode") === "1";
  });
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode);
  const [hideTitlebar, setHideTitlebar] = useState(() => readStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, false));
  const [updateAutoCheck, setUpdateAutoCheck] = useState(() =>
    readStoredBoolean(SETTINGS_UPDATE_AUTO_CHECK_KEY, true),
  );
  const [updateAutoDownload, setUpdateAutoDownload] = useState(() =>
    readStoredBoolean(SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY, false),
  );
  const [configActionStatus, setConfigActionStatus] = useState<string | null>(null);
  // Disconnecting a provider reloads the engine, which takes seconds. Track the
  // in-flight provider so the row can show progress instead of looking inert.
  const [disconnectingProviderId, setDisconnectingProviderId] = useState<string | null>(null);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null);
  const [editingLocalProvider, setEditingLocalProvider] = useState<CustomProviderInput | null>(null);
  const [reconnectingProviderId, setReconnectingProviderId] = useState<string | null>(null);
  const [providerDisconnectError, setProviderDisconnectError] = useState<string | null>(null);
  const [revealConfigBusy, setRevealConfigBusy] = useState(false);
  const [resetConfigBusy, setResetConfigBusy] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceInitialScreen, setCreateWorkspaceInitialScreen] =
    useState<CreateWorkspaceScreen>("chooser");
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [exportWorkspaceBusy, setExportWorkspaceBusy] = useState(false);
  const [autoCompactContext, setAutoCompactContext] = useState(true);
  const [autoCompactContextBusy, setAutoCompactContextBusy] = useState(false);
  const [autoCompactContextLoaded, setAutoCompactContextLoaded] = useState(false);
  const [globalMcpEntries, setGlobalMcpEntries] = useState<GlobalMcpEntry[]>([]);
  const [pendingGlobalConnector, setPendingGlobalConnector] = useState<string | null>(null);
  const [deletingGlobalSkill, setDeletingGlobalSkill] = useState<string | null>(null);
  const [globalExtensionsError, setGlobalExtensionsError] = useState<string | null>(null);
  const [localProviderBusy, setLocalProviderBusy] = useState(false);
  const [localProviderStatus, setLocalProviderStatus] = useState<string | null>(null);
  const [localProviderError, setLocalProviderError] = useState<string | null>(null);
  const [googleWorkspaceConnected, setGoogleWorkspaceConnected] = useState(false);
  const [imageExtensionBusy, setImageExtensionBusy] = useState(false);
  const [imageExtensionStatus, setImageExtensionStatus] = useState<string | null>(null);
  const [imageExtensionError, setImageExtensionError] = useState<string | null>(null);
  const [computerUsePermissions, setComputerUsePermissions] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);
  const [extensionStateVersion, setExtensionStateVersion] = useState(0);
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false);
  const [imageGenerationStatus, setImageGenerationStatus] = useState<string | null>(null);
  const [imageGenerationError, setImageGenerationError] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [userEnvKeys, setUserEnvKeys] = useState<string[]>([]);
  const [cloudMcpHealth, setCloudMcpHealth] = useState<JuggleWorkCloudMcpHealth | null>(null);
  const emptyWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () => ({
      id: "",
      name: t("session.workspace_fallback"),
      path: "",
      preset: "starter",
      workspaceType: "local",
    }),
    [],
  );

  const routeStateRef = useRef({
    activeClient: null as Client | null,
    providerBaseUrl: "",
    selectedWorkspaceId: "",
    selectedWorkspaceRoot: "",
    selectedWorkspaceType: "local" as "local" | "remote",
    runtimeWorkspaceId: null as string | null,
    juggleworkServerClient: null as JuggleWorkServerClient | null,
    selectedWorkspaceJuggleWorkClient: null as JuggleWorkServerClient | null,
    juggleworkServerStatus: "disconnected" as "connected" | "disconnected",
    juggleworkServerCapabilities: null as JuggleWorkServerCapabilities | null,
    selectedWorkspaceDisplay: emptyWorkspaceDisplay as WorkspaceDisplay,
    providerItems: [] as ProviderListItem[],
    providerDefaults: {} as Record<string, string>,
    providerConnectedIds: [] as string[],
    disabledProviders: [] as string[],
    developerMode: false,
  });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);
  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  const selectedWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () =>
      selectedWorkspace
        ? {
            id: selectedWorkspace.id,
            name: selectedWorkspace.name ?? selectedWorkspace.displayNameResolved,
            path: selectedWorkspace.path ?? "",
            preset: "starter",
            workspaceType: selectedWorkspace.workspaceType ?? "local",
            displayName: selectedWorkspace.displayNameResolved,
            juggleworkWorkspaceName: selectedWorkspace.juggleworkWorkspaceName,
          }
        : emptyWorkspaceDisplay,
    [emptyWorkspaceDisplay, selectedWorkspace],
  );
  const workspaceServerClientResolver = useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl, token, hostToken }),
    [baseUrl, hostToken, token],
  );
  const selectedWorkspaceEndpoint = useWorkspaceServerClient(selectedWorkspace, {
    baseUrl,
    token,
    hostToken,
  });
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";

  routeStateRef.current = {
    activeClient,
    providerBaseUrl: opencodeBaseUrl,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedWorkspaceType: selectedWorkspace?.workspaceType ?? "local",
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    juggleworkServerClient: juggleworkClient,
    selectedWorkspaceJuggleWorkClient: juggleworkClient,
    juggleworkServerStatus: juggleworkClient ? "connected" : "disconnected",
    juggleworkServerCapabilities: juggleworkClient ? ROUTE_JUGGLEWORK_CAPABILITIES : null,
    selectedWorkspaceDisplay,
    providerItems: providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviders,
    developerMode,
  };

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );

  const juggleworkServerStore = useMemo(
    () =>
      createJuggleWorkServerStore({
        startupPreference: () => {
          // In desktop mode, loopback URLs are ephemeral local runtime details.
          // Only non-loopback stored URLs indicate an explicit remote/manual
          // server connection preference.
          if (!isDesktopRuntime()) return "server";
          const stored = readJuggleWorkServerSettings();
          const storedUrl = stored.urlOverride?.trim() ?? "";
          return storedUrl && !isLoopbackJuggleWorkServerUrl(storedUrl) ? "server" : "local";
        },
        documentVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
        developerMode: () => routeStateRef.current.developerMode,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        activeClient: () => routeStateRef.current.activeClient,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        restartLocalServer: async () => {
          if (!isDesktopRuntime()) return false;
          try {
            await juggleworkServerRestart({
              remoteAccessEnabled:
                readJuggleWorkServerSettings().remoteAccessEnabled === true,
            });
            return true;
          } catch {
            return false;
          }
        },
        createRemoteWorkspaceFlow: async () => false,
      }),
    [],
  );
  const connectionsStore = useMemo(
    () =>
      createConnectionsStore({
        client: () => routeStateRef.current.activeClient,
        setClient: setActiveClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        juggleworkServer: juggleworkServerStore,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        developerMode: () => routeStateRef.current.developerMode,
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [juggleworkServerStore, reloadCoordinator.markReloadRequired],
  );
  refreshMcpServersRef.current = connectionsStore.refreshMcpServers;
  notifyMcpReloadingRef.current = connectionsStore.notifyMcpReloading;
  pollMcpServersAfterReloadRef.current = connectionsStore.pollMcpServersAfterReload;
  const providerAuthStore = useMemo(
    () =>
      createProviderAuthStore({
        client: () => routeStateRef.current.activeClient,
        providers: () => routeStateRef.current.providerItems,
        providerDefaults: () => routeStateRef.current.providerDefaults,
        providerConnectedIds: () => routeStateRef.current.providerConnectedIds,
        disabledProviders: () => routeStateRef.current.disabledProviders,
        checkDesktopAppRestriction: checkDesktopRestriction,
        providerBaseUrl: () => routeStateRef.current.providerBaseUrl,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        juggleworkServer: juggleworkServerStore,
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders,
        markOpencodeConfigReloadRequired: () => {
          setConfigActionStatus(t("settings.config_updated"));
          reloadCoordinator.markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [checkDesktopRestriction, juggleworkServerStore, reloadCoordinator.markReloadRequired],
  );
  const extensionsStore = useMemo(
    () =>
      createExtensionsStore({
        client: () => routeStateRef.current.activeClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        juggleworkServer: juggleworkServerStore,
        juggleworkServerConnection: () => ({
          juggleworkServerClient: routeStateRef.current.juggleworkServerClient,
          juggleworkServerStatus: routeStateRef.current.juggleworkServerStatus,
          juggleworkServerCapabilities: routeStateRef.current.juggleworkServerCapabilities,
        }),
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        setBusy,
        setBusyLabel,
        setBusyStartedAt: () => {},
        setError: (message) => {
          if (message) {
            toast.error(message);
          }
        },
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [juggleworkServerStore, reloadCoordinator.markReloadRequired],
  );
  const juggleworkServerSnapshot = useJuggleWorkServerStoreSnapshot(juggleworkServerStore);
  const connectionsSnapshot = useConnectionsStoreSnapshot(connectionsStore);
  const providerAuthSnapshot = useProviderAuthStoreSnapshot(providerAuthStore);
  const extensionsSnapshot = useExtensionsStoreSnapshot(extensionsStore);
  const orgMcpConnections = useOrgMcpConnections();

  useEffect(() => {
    for (const provider of providers) {
      providerDisplayCacheRef.current.set(provider.id.trim().toLowerCase(), provider);
    }
  }, [providers]);

  const juggleworkServerStatusForMcp = juggleworkServerSnapshot.juggleworkServerStatus;
  useEffect(() => {
    if (juggleworkServerStatusForMcp !== "connected") return;
    // The first MCP read races the jugglework-server store's initial health
    // check (a fresh store always starts "disconnected"), so it falls back
    // to config files where server-runtime (config.remote) entries — notably
    // the cloud control MCP — don't exist. Without this re-read the built-in
    // cards show "Tap to connect" until the next full remount even though
    // the entries are configured and healthy.
    void connectionsStore.refreshMcpServers();
  }, [connectionsStore, juggleworkServerStatusForMcp]);

  const cleanupCloudMcpForSignOut = useCallback(async (settings: DenSettings) => {
    const client = routeStateRef.current.selectedWorkspaceJuggleWorkClient;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!client || !workspaceId || !orgId) return;
    // Settings only has a safe, exact OpenCode client/directory for the active
    // workspace here, so sign-out cleanup is intentionally scoped to that
    // workspace instead of guessing across every configured worker.
    //
    // This is no longer the only path: the provider-auth store purges the
    // cloud MCP on every sign-out and account switch, and settles other
    // workspaces from their owner stamp when they are next opened. This hook
    // stays because it runs BEFORE the session is cleared, so it still has the
    // org id needed to drop the scoped local markers as well as the token.
    await cleanupJuggleWorkCloudMcpAfterSignOut({
      context: {
        denBaseUrl: settings.baseUrl,
        serverBaseUrl: client.baseUrl,
        workspaceId,
        orgId,
      },
      juggleworkClient: client,
      opencodeClient: routeStateRef.current.activeClient,
      directory: routeStateRef.current.selectedWorkspaceRoot,
    });
    setCloudMcpHealth(null);
    await refreshMcpServersRef.current?.();
  }, []);
  const denSession = useDenSession({
    developerMode,
    onBeforeSignedOut: cleanupCloudMcpForSignOut,
    openLink: (url) => platform.openLink(url),
  });
  const cloudSession = useCloudSession();
  const [connectCapabilities, setConnectCapabilities] = useState<ConnectCapabilityInventory>(
    EMPTY_CONNECT_CAPABILITY_INVENTORY,
  );
  const connectCapabilitiesRequestRef = useRef(0);
  const refreshConnectCapabilities = useCallback(async () => {
    const requestId = connectCapabilitiesRequestRef.current + 1;
    connectCapabilitiesRequestRef.current = requestId;
    const organizationId = cloudSession.activeOrganization?.id?.trim() ?? "";
    if (!cloudSession.isSignedIn || !organizationId) {
      setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      return;
    }
    try {
      const inventory = await listAssignedConnectCapabilities({
        client: cloudSession.client,
        organizationId,
      });
      if (connectCapabilitiesRequestRef.current === requestId) {
        setConnectCapabilities(inventory);
      }
    } catch {
      if (connectCapabilitiesRequestRef.current === requestId) {
        setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      }
    }
  }, [cloudSession.activeOrganization?.id, cloudSession.client, cloudSession.isSignedIn]);

  useEffect(() => {
    if (route.tab !== "extensions") return;
    void refreshConnectCapabilities();
  }, [refreshConnectCapabilities, route.tab]);

  const handleOpenProviderAuth = useCallback(() => {
    if (checkDesktopRestriction({ restriction: "allowCustomProviders" })) {
      restrictionNotice.show({
        title: "Adding custom providers is disabled",
        message: "Your organization administrator has disabled adding custom providers.",
      });
      return;
    }

    setEditingLocalProvider(null);
    void providerAuthStore.openProviderAuthModal();
  }, [checkDesktopRestriction, providerAuthStore, restrictionNotice]);

  useEffect(() => {
    if (!activeClient || !selectedWorkspaceId) return;
    // Org policy may force Zen off. Never force it back on — that races user Disconnect.
    if (!checkDesktopRestriction({ restriction: "allowZenModel" })) return;

    void providerAuthStore
      .ensureProjectProviderDisabledState("opencode", true)
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [activeClient, checkDesktopRestriction, providerAuthStore, selectedWorkspaceId, selectedWorkspaceRoot]);

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    juggleworkServerHostInfo: juggleworkServerSnapshot.juggleworkServerHostInfo,
    juggleworkServerSettings: juggleworkServerSnapshot.juggleworkServerSettings,
    engineInfo: null,
    exportWorkspaceBusy,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });

  const debugViewProps = useDebugViewModel({
    developerMode,
    juggleworkServerStore,
    juggleworkServerSnapshot,
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    selectedWorkspaceRoot,
    setRouteError: (message) => {
      if (message) {
        toast.error(message);
      }
    },
  });
  const onReleaseChannelChange = useCallback(
    (next: "stable" | "alpha") => {
      local.setPrefs((previous) => ({ ...previous, releaseChannel: next }));
    },
    [local],
  );
  const electronUpdaterState = useElectronUpdaterState({
    releaseChannel: local.prefs.releaseChannel ?? "stable",
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    desktopConfig: desktopConfig.config,
    refreshDesktopConfig: desktopConfig.refreshFresh,
    setError: (message) => {
      if (message) {
        // Auto-checks can fail without any user action; alert + log to the
        // notification center instead of a bare toast.
        notifyAlert({
          kind: "update",
          title: t("notifications.updater_error"),
          body: message,
          dedupeKey: "updater-error",
        });
      }
    },
  });

  const workspaceSessionGroups = useMemo(
    // Settings has no per-workspace loading state; the empty set keeps the
    // previous behavior (error -> "error", otherwise "ready").
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set()),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const runtimeWorkspaceId = selectedWorkspaceEndpoint?.workspaceId ?? selectedWorkspace?.id ?? null;
  routeStateRef.current.runtimeWorkspaceId = runtimeWorkspaceId;
  routeStateRef.current.selectedWorkspaceJuggleWorkClient = selectedWorkspaceEndpoint?.client ?? juggleworkClient;

  const opencodeClient = useMemo(() => {
    if (!selectedWorkspaceEndpoint || !selectedWorkspaceEndpoint.token) return null;
    return createClient(
      selectedWorkspaceEndpoint.opencodeBaseUrl,
      selectedWorkspaceRoot || undefined,
      {
        token: selectedWorkspaceEndpoint.token,
        mode: "jugglework",
      },
    );
  }, [selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  useEffect(() => {
    setActiveClient(opencodeClient);
  }, [opencodeClient]);

  const handleModelPickerLoadError = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t("app.unknown_error"));
  }, []);
  const handleModelPickerOpen = useCallback(() => {
    void providerAuthStore.runCloudProviderSync("model_picker_open");
  }, [providerAuthStore]);
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onOpen: handleModelPickerOpen,
    onLoadError: handleModelPickerLoadError,
  });
  const currentCloudMcpModel = useMemo<JuggleWorkCloudMcpProviderModelContext | null>(() => {
    const provider = local.prefs.defaultModel?.providerID.trim() ?? "";
    const model = local.prefs.defaultModel?.modelID.trim() ?? "";
    return provider && model ? { provider, model } : null;
  }, [local.prefs.defaultModel]);
  const refreshCloudMcpHealth = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      setCloudMcpHealth(null);
      return null;
    }
    // probe: the Advanced page refresh should verify the Cloud endpoint
    // directly (outside the engine), not just report the engine's cached state.
    const health = await client.getJuggleWorkCloudMcpHealth(workspaceId, currentCloudMcpModel ?? undefined, { probe: true });
    setCloudMcpHealth(health);
    return health;
  }, [currentCloudMcpModel, juggleworkClient, runtimeWorkspaceId, selectedWorkspaceEndpoint]);
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut(!props.embedded);
  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );
  const handleCreatePaletteSession = useCallback(async () => {
    if (!opencodeClient || !selectedWorkspaceId) {
      navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session");
      return;
    }
    try {
      const session = unwrap(
        await opencodeClient.session.create({ directory: selectedWorkspaceRoot || undefined }),
      );
      navigate(workspaceSessionRoute(selectedWorkspaceId, session.id));
    } catch (error) {
      toast.error(describeRouteError(error));
    }
  }, [navigate, opencodeClient, selectedWorkspaceId, selectedWorkspaceRoot]);
  // Settings refreshes provider auth whenever the picker opens (the session
  // route does not need this; its provider state is kept fresh elsewhere).
  useEffect(() => {
    if (!modelPicker.open) return;
    void providerAuthStore.refreshProviders();
  }, [modelPicker.open, providerAuthStore]);

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(JUGGLEWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(JUGGLEWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || !isMacPlatform()) return;
    let cancelled = false;
    void desktopBridge.checkComputerUsePermissions()
      .then((result) => {
        if (cancelled) return;
        const permissions = normalizeComputerUsePermissions(result);
        if (permissions) setComputerUsePermissions(permissions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
    if (!client) {
      setGoogleWorkspaceConnected(false);
      return;
    }

    let cancelled = false;
    void client.googleWorkspaceStatus()
      .then((result) => {
        if (!cancelled) setGoogleWorkspaceConnected(result.connected === true);
      })
      .catch(() => {
        if (!cancelled) setGoogleWorkspaceConnected(false);
      });

    return () => {
      cancelled = true;
    };
  }, [juggleworkClient, selectedWorkspaceEndpoint]);

  useEffect(() => {
    if (!juggleworkClient) {
      setUserEnvKeys([]);
      return;
    }
    let cancelled = false;
    void juggleworkClient.listUserEnvKeys()
      .then((response) => { if (!cancelled) setUserEnvKeys(response.keys); })
      .catch(() => { if (!cancelled) setUserEnvKeys([]); });
    return () => { cancelled = true; };
  }, [juggleworkClient]);

  const installOpenAiImageExtension = useCallback(async (apiKey: string) => {
    const resolvedApiKey = apiKey.trim();
    if (!juggleworkClient) {
      setImageExtensionError("JuggleWork server is not connected.");
      return;
    }
    if (!resolvedApiKey) {
      setImageExtensionError("OpenAI API key is required.");
      return;
    }

    setImageExtensionBusy(true);
    setImageExtensionStatus(null);
    setImageExtensionError(null);
    try {
      await juggleworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: resolvedApiKey }]);
      setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      setImageExtensionStatus("Saved OPENAI_API_KEY. Agents can use JuggleWork extension actions for image generation.");
    } catch (error) {
      setImageExtensionError(describeRouteError(error));
    } finally {
      setImageExtensionBusy(false);
    }
  }, [juggleworkClient]);

  const generateOpenAiTestImage = useCallback(async (input: { apiKey: string; prompt: string }) => {
    const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const apiKey = input.apiKey.trim();
    const prompt = input.prompt.trim();
    if (!client || !workspaceId) {
      setImageGenerationError("JuggleWork server is not connected for this workspace.");
      return;
    }
    if (!apiKey) {
      setImageGenerationError("OpenAI API key is required.");
      return;
    }
    if (!prompt) {
      setImageGenerationError("Prompt is required.");
      return;
    }

    setImageGenerationBusy(true);
    setImageGenerationStatus(null);
    setImageGenerationError(null);
    try {
      if (juggleworkClient) {
        await juggleworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: apiKey }]);
        setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      }
      const response = await client.callExtensionAction({
        extensionId: OPENAI_IMAGE_EXTENSION_ID,
        action: "image_generate",
        args: { prompt },
        context: { directory: selectedWorkspaceRoot || undefined },
      });
      if (!response.ok) {
        setImageGenerationError(response.message);
        return;
      }
      const result = response.result;
      const path = typeof result === "object" && result !== null && "path" in result && typeof result.path === "string"
        ? result.path
        : "an artifact";
      setImageGenerationStatus(`Generated ${path} with ${OPENAI_IMAGE_MODEL}.`);
    } catch (error) {
      setImageGenerationError(describeRouteError(error));
    } finally {
      setImageGenerationBusy(false);
    }
  }, [juggleworkClient, runtimeWorkspaceId, selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  const saveVoiceApiKey = useCallback(async (apiKey: string) => {
    const resolvedApiKey = apiKey.trim();
    if (!juggleworkClient || !resolvedApiKey) {
      setVoiceError("OpenAI API key is required.");
      return;
    }
    setVoiceBusy(true);
    setVoiceStatus(null);
    setVoiceError(null);
    try {
      await juggleworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: resolvedApiKey }]);
      setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      setVoiceStatus("Saved OPENAI_API_KEY for Voice Mode.");
    } catch (error) {
      setVoiceError(describeRouteError(error));
    } finally {
      setVoiceBusy(false);
    }
  }, [juggleworkClient]);

  const testVoiceSession = useCallback(async () => {
    if (!juggleworkClient) {
      setVoiceError("JuggleWork server is not connected.");
      return;
    }
    setVoiceBusy(true);
    setVoiceStatus(null);
    setVoiceError(null);
    try {
      const session = await juggleworkClient.createVoiceRealtimeSession();
      setVoiceStatus(`Realtime ready with ${session.model} (${session.tools.length} JuggleWork tools).`);
    } catch (error) {
      setVoiceError(describeRouteError(error));
    } finally {
      setVoiceBusy(false);
    }
  }, [juggleworkClient]);

  const installLocalProvider = useCallback(async (input: LocalProviderInstallInput) => {
    const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const modelId = input.modelId.trim();
    if (!client || !workspaceId) {
      setLocalProviderError("JuggleWork server is not connected for this workspace.");
      return;
    }
    if (!modelId) {
      setLocalProviderError("Model ID is required.");
      return;
    }

    setLocalProviderBusy(true);
    setLocalProviderStatus(null);
    setLocalProviderError(null);
    try {
      await client.patchConfig(workspaceId, {
        opencode: {
          provider: {
            [input.providerId]: buildLocalProviderConfig({ ...input, modelId }),
          },
        },
      });
      if (input.setDefault) {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: { providerID: input.providerId, modelID: modelId },
          modelVariant: null,
        }));
      }
      reloadCoordinator.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      try {
        await reloadEngineOrRestartDesktop(client, workspaceId);
      } catch {
        // The reload toast still lets the user retry if the immediate reload fails.
      }
      await refreshProviderListQueries(getReactQueryClient());
      try {
        window.dispatchEvent(new CustomEvent("jugglework-server-settings-changed"));
      } catch {
        // ignore browser event dispatch failures
      }
      setLocalProviderStatus(`Added ${input.name} with ${modelId}.`);
    } catch (error) {
      setLocalProviderError(describeRouteError(error));
    } finally {
      setLocalProviderBusy(false);
    }
  }, [local, juggleworkClient, reloadCoordinator, runtimeWorkspaceId, selectedWorkspaceEndpoint]);

  useEffect(() => {
    local.setUi((previous) => ({ ...previous, view: "settings", tab: route.tab }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- local is stable via context
  }, [route.tab]);

  useEffect(() => {
    setAppThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, hideTitlebar);
  }, [hideTitlebar]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_UPDATE_AUTO_CHECK_KEY, updateAutoCheck);
  }, [updateAutoCheck]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY, updateAutoDownload);
  }, [updateAutoDownload]);

  const { markRouteReady: markBootRouteReady } = useBootState();
  const refreshRouteState = useMemo(() => async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap() as WorkspaceList;
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[settings-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "settings",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }
      const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveJuggleWorkConnection();

      if (!normalizedBaseUrl || !resolvedToken) {
        setJuggleWorkClient(null);
        setBaseUrl("");
        setToken("");
        setHostToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
        return;
      }

      const client = createJuggleWorkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await client.listWorkspaces();
      const serverWorkspaceIds = new Set(list.items.map((workspace) => workspace.id));
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces);
      const routeWorkspaceServerClientResolver = createWorkspaceServerClientResolver({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken,
      });
      const sessionEntries = await Promise.all(
        nextWorkspaces.map(async (workspace) => {
          const endpoint = routeWorkspaceServerClientResolver(workspace);
          if (!endpoint) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          if (!endpoint.isRemote && !serverWorkspaceIds.has(workspace.id)) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          try {
            const response = await endpoint.client.listSessions(endpoint.workspaceId, { limit: 200 });
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot && !endpoint.isRemote
              ? (response.items ?? []).filter((session) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : (response.items ?? []);
            return {
              workspaceId: workspace.id,
              sessions: items,
              error: null as string | null,
              connectionState: null as WorkspaceConnectionState | null,
            };
          } catch (error) {
            const fallback = error instanceof Error ? error.message : t("app.unknown_error");
            if (workspace.workspaceType === "remote") {
              const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, fallback);
              return {
                workspaceId: workspace.id,
                sessions: [],
                error: connectionState.message ?? "Remote worker connection failed.",
                connectionState,
              };
            }
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: fallback,
              connectionState: null,
            };
          }
        }),
      );

      setJuggleWorkClient(client);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setHostToken(resolvedHostToken);
      setWorkspaces(nextWorkspaces);
      setSessionsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.sessions])));
      setErrorsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.error])));
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        for (const entry of sessionEntries) {
          if (entry.connectionState) {
            next[entry.workspaceId] = entry.connectionState;
          } else if (next[entry.workspaceId]?.status === "error") {
            delete next[entry.workspaceId];
          }
        }
        return next;
      });
      setLegacySelectedWorkspaceId((current) => {
        const sessionWorkspaceId = findSessionWorkspaceId(navigationSessionId, sessionEntries);
        const preferred = routeWorkspaceId || sessionWorkspaceId || navigationWorkspaceId || current || readActiveWorkspaceId() || "";
        const next = reconcileSelectedWorkspaceId(preferred, list, desktopList, nextWorkspaces);
        writeActiveWorkspaceId(next || null);
        return next;
      });
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[settings-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "settings",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      // Fires on mount/auto-refresh too, not just user actions.
      notifyAlert({
        kind: "system",
        title: t("notifications.refresh_failed"),
        body: message,
        dedupeKey: "settings-route-refresh",
      });
      if (desktopWorkspaces.length > 0) {
        setWorkspaces(desktopWorkspaces);
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Settings can be the first route a user lands on (direct link, deep
      // link, or after reload). Let the boot overlay dismiss once we've
      // completed our first data load.
      markBootRouteReady();
    }
  }, [markBootRouteReady, navigationSessionId, navigationWorkspaceId, routeWorkspaceId]);

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId.trim();
    if (!juggleworkClient || !workspaceId) {
      toast.error(t("app.error_connect_first"));
      return false;
    }

    await reloadEngineOrRestartDesktop(juggleworkClient, workspaceId, refreshRouteState);
    await refreshProviderListQueries(getReactQueryClient());

    try {
      window.dispatchEvent(new CustomEvent("jugglework-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }

    // OpenCode reconnects MCPs async after dispose — the store polls until
    // statuses settle so users don't have to collapse/expand the card.
    void pollMcpServersAfterReloadRef.current?.();

    return true;
  }, [juggleworkClient, refreshRouteState, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(juggleworkClient && (selectedWorkspace?.id || selectedWorkspaceId)),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
      stopSession: async (sessionId) => {
        if (!activeClient) return;
        await abortSessionSafe(activeClient, sessionId);
      },
    });
  }, [
    activeClient,
    activeReloadBlockingSessions,
    juggleworkClient,
    reloadCoordinator,
    reloadWorkspaceEngineFromUi,
    selectedWorkspace?.id,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaces]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });

  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (juggleworkClient) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalJuggleWorkConnection({
      route: "settings",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      // Background auto-reconnect: alert + persistent center entry.
      notifyAlert({
        kind: "system",
        title: t("notifications.reconnect_failed"),
        body: message,
        dedupeKey: "server-reconnect",
      });
    });
  }, [loading, juggleworkClient, selectedWorkspace, workspaces]);

  useEffect(() => {
    void refreshRouteState();
    const handleSettingsChange = () => {
      void refreshRouteState();
    };
    window.addEventListener("jugglework-server-settings-changed", handleSettingsChange);
    return () => {
      window.removeEventListener("jugglework-server-settings-changed", handleSettingsChange);
    };
  }, [refreshRouteState]);

  // TIPS: 全局 OpenCode 配置的读写目标，自动压缩与全局连接器共用。这里仍依赖
  // workspaceId，只是因为服务端按工作区暴露配置文件读写入口，与作用域无关；
  // 切换工作区不会改变取值。
  const globalConfigTarget = useCallback((): GlobalConfigTarget | null => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    if (!workspaceId) return null;
    return {
      juggleworkClient,
      workspaceId,
      workspaceRoot: selectedWorkspaceRoot,
      isLocalWorkspace: (selectedWorkspace?.workspaceType ?? "local") === "local",
    };
  }, [juggleworkClient, selectedWorkspace?.workspaceType, selectedWorkspaceId, selectedWorkspaceRoot]);

  useEffect(() => {
    const target = globalConfigTarget();
    if (!target) return;
    let cancelled = false;
    (async () => {
      try {
        const auto = await readGlobalAutoCompaction(target);
        if (cancelled) return;
        setAutoCompactContext(auto);
      } catch {
        // 读取失败时保留默认的开启状态。
      } finally {
        if (!cancelled) setAutoCompactContextLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [globalConfigTarget]);

  const toggleAutoCompactContext = useCallback(async () => {
    if (autoCompactContextBusy) return;
    const target = globalConfigTarget();
    if (!target) return;
    const next = !autoCompactContext;
    setAutoCompactContext(next);
    setAutoCompactContextBusy(true);
    try {
      await writeGlobalAutoCompaction(target, next);
      reloadCoordinator.markReloadRequired("config", {
        type: "config",
        name: "opencode.json",
        action: "updated",
      });
    } catch {
      setAutoCompactContext(!next);
    } finally {
      setAutoCompactContextBusy(false);
    }
  }, [autoCompactContext, autoCompactContextBusy, globalConfigTarget, reloadCoordinator]);

  // ---- 全局技能与全局连接器 ----

  const globalSkills = useMemo(
    () => extensionsSnapshot.skills.filter((skill) => skill.scope === "global"),
    [extensionsSnapshot.skills],
  );

  const refreshGlobalConnectors = useCallback(async () => {
    const target = globalConfigTarget();
    if (!target) return;
    try {
      setGlobalMcpEntries(await readGlobalMcpEntries(target));
      setGlobalExtensionsError(null);
    } catch (error) {
      setGlobalExtensionsError(error instanceof Error ? error.message : t("mcp.load_failed"));
    }
  }, [globalConfigTarget]);

  // 只在打开对应页面时读取，避免会话右侧面板和其他设置页付出无谓的配置文件读取。
  const connectorsTabActive = route.tab === "connectors";
  useEffect(() => {
    if (!connectorsTabActive) return;
    void refreshGlobalConnectors();
  }, [connectorsTabActive, refreshGlobalConnectors]);

  const skillsTabActive = route.tab === "skills";
  useEffect(() => {
    if (!skillsTabActive) return;
    void extensionsStore.refreshSkills({ force: true });
  }, [extensionsStore, skillsTabActive]);

  // TIPS: 条目与连接状态来自全局配置文件，写入也回到同一个文件。运行时层的
  // MCP 接口只作用于工作区，不能用来承载全局连接器。
  const globalConnectors = useMemo<GlobalConnectorItem[]>(
    () => globalMcpEntries.map((entry) => ({
      name: entry.name,
      config: entry.config,
      status: connectionsSnapshot.mcpStatuses[entry.name],
    })),
    [connectionsSnapshot.mcpStatuses, globalMcpEntries],
  );

  const runGlobalConnectorWrite = useCallback(async (
    name: string,
    write: (target: GlobalConfigTarget) => Promise<void>,
  ) => {
    const target = globalConfigTarget();
    if (!target) return;
    setPendingGlobalConnector(name);
    setGlobalExtensionsError(null);
    try {
      await write(target);
      reloadCoordinator.markReloadRequired("config", {
        type: "config",
        name: "opencode.json",
        action: "updated",
      });
      await refreshGlobalConnectors();
      void connectionsStore.refreshMcpServers();
    } catch (error) {
      setGlobalExtensionsError(error instanceof Error ? error.message : t("mcp.remove_failed"));
      throw error;
    } finally {
      setPendingGlobalConnector(null);
    }
  }, [connectionsStore, globalConfigTarget, refreshGlobalConnectors, reloadCoordinator]);

  const addGlobalConnector = useCallback(
    (name: string, config: McpServerConfig) =>
      runGlobalConnectorWrite(name, (target) => upsertGlobalMcp(target, name, config)),
    [runGlobalConnectorWrite],
  );

  const toggleGlobalConnector = useCallback(
    (name: string, enabled: boolean) =>
      runGlobalConnectorWrite(name, (target) => setGlobalMcpEnabled(target, name, enabled)),
    [runGlobalConnectorWrite],
  );

  const removeGlobalConnector = useCallback(
    (name: string) => runGlobalConnectorWrite(name, (target) => removeGlobalMcp(target, name)),
    [runGlobalConnectorWrite],
  );

  const deleteGlobalSkill = useCallback(async (name: string) => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    if (!juggleworkClient || !workspaceId) {
      // 不能静默返回：用户点了删除却毫无反馈，会以为是应用卡住了。
      setGlobalExtensionsError(t("skills.uninstall_failed"));
      return;
    }
    setDeletingGlobalSkill(name);
    setGlobalExtensionsError(null);
    try {
      await juggleworkClient.deleteSkill(workspaceId, name, { scope: "global" });
      await extensionsStore.refreshSkills({ force: true });
    } catch (error) {
      setGlobalExtensionsError(error instanceof Error ? error.message : t("skills.uninstall_failed"));
    } finally {
      setDeletingGlobalSkill(null);
    }
  }, [extensionsStore, juggleworkClient, selectedWorkspaceId]);

  useEffect(() => {
    juggleworkServerStore.start();
    connectionsStore.start();
    providerAuthStore.start();
    extensionsStore.start();

    return () => {
      extensionsStore.dispose();
      providerAuthStore.dispose();
      connectionsStore.dispose();
      juggleworkServerStore.dispose();
    };
  }, [connectionsStore, extensionsStore, juggleworkServerStore, providerAuthStore]);

  const refreshMarketplaceAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "extensions.refresh-marketplace",
    label: "Refresh marketplace extensions",
    description: "Force a fresh sync of organization marketplace plugins from the cloud.",
    sideEffect: "mutation",
    execute: async () => {
      await extensionsStore.refreshCloudOrgMarketplaces({ force: true });
      return { marketplaceCount: extensionsStore.cloudOrgMarketplaces().length };
    },
  }), [extensionsStore]);
  useControlAction(refreshMarketplaceAction);

  // Periodically reconcile workspace-imported cloud providers from Den while
  // signed in (dev #1509 "auto-sync cloud providers"). Mounted here because
  // the settings route owns the provider-auth store.
  useCloudProviderAutoSync(providerAuthStore.runCloudProviderSync);

  // Keep the Den cloud MCP configured with a fresh first-party token while
  // signed in: connects on sign-in, re-mints on org switch and before expiry.
  useCloudProviderAutoSync(() => connectionsStore.syncCloudControlMcp());

  useEffect(() => {
    if (route.tab !== "cloud-providers") return;
    void providerAuthStore.runCloudProviderSync("settings_cloud_opened");
  }, [providerAuthStore, route.tab]);

  useEffect(() => {
    juggleworkServerStore.syncFromOptions();
    connectionsStore.syncFromOptions();
    providerAuthStore.syncFromOptions();
    extensionsStore.syncFromOptions();
  }, [
    activeClient,
    connectionsStore,
    extensionsStore,
    juggleworkServerStore,
    providerAuthStore,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceRoot,
  ]);

  useEffect(() => {
    if (!activeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      setDisabledProviders([]);
      return;
    }
    void providerAuthStore.refreshProviders();
    void connectionsStore.refreshMcpServers();
  }, [activeClient, connectionsStore, providerAuthStore, selectedWorkspace?.id]);

  const selectedWorkspaceName = selectedWorkspace?.displayNameResolved ?? t("session.workspace_fallback");
  const workspaceOptions = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.displayNameResolved,
    color: workspaceSwatchColor(workspace.id),
  }));
  const selectedWorkspaceColor = workspaceSwatchColor(selectedWorkspaceId);
  const workspaceType = selectedWorkspace?.workspaceType ?? "local";
  const isRemoteWorkspace = workspaceType === "remote";
  const canWriteWorkspacePlugins =
    !isRemoteWorkspace || juggleworkServerSnapshot.juggleworkServerCanWritePlugins;
  const pluginsAccessHint =
    isRemoteWorkspace && !canWriteWorkspacePlugins ? t("app.plugins_hint_readonly") : null;
  const defaultModelLabel = local.prefs.defaultModel
    ? (() => {
        const provider = providers.find((item) => item.id === local.prefs.defaultModel?.providerID);
        const model = provider?.models?.[local.prefs.defaultModel.modelID];
        const providerLabel = provider?.name ?? resolveProviderDisplayName(local.prefs.defaultModel.providerID);
        const modelLabel = model?.name ?? resolveModelDisplayName(local.prefs.defaultModel.modelID);
        return `${providerLabel} - ${modelLabel}`;
      })()
    : t("session.default_model");
  const defaultModelRef = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("settings.default_label");
  const defaultModelVariantLabel = local.prefs.modelVariant ?? t("settings.default_label");
  const providerConnectedIdSet = new Set(providerConnectedIds);
  const disabledProviderIdSet = new Set(
    disabledProviders.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  // Providers a Disconnect parked in `disabled_providers` are dropped from
  // the engine list. Keep their last known metadata so the same row can remain
  // visible while only its connection state and actions change.
  // TIPS：首次加载时可能只有 provider id，此时仍合并进主列表，避免断开项
  // 被移动到独立区域；下一次连接后会用引擎返回的完整信息刷新缓存。
  const reconnectableDisabledProviderIds = disabledProviders
    .map((id) => id.trim())
    .filter(
      (id) =>
        id &&
        !isDesktopProviderBlocked({
          providerId: id,
          checkRestriction: checkDesktopRestriction,
          allowedModels,
          providerSource: "config",
        }),
    );
  const retainedDisconnectedProviderIds = Array.from(new Set([
    ...reconnectableDisabledProviderIds,
    ...(reconnectingProviderId ? [reconnectingProviderId] : []),
  ]));
  const providerRows = new Map<string, {
    id: string;
    name: string;
    source?: "env" | "api" | "config" | "custom";
    connected: boolean;
  }>();
  for (const provider of providers) {
    const normalizedId = provider.id.trim().toLowerCase();
    if (!normalizedId || normalizedId === "jugglework") continue;
    const isConnected =
      providerConnectedIdSet.has(provider.id) && !disabledProviderIdSet.has(normalizedId);
    if (!isConnected && !disabledProviderIdSet.has(normalizedId)) continue;
    providerRows.set(normalizedId, {
      id: provider.id,
      name: provider.name ?? provider.id,
      source: provider.source,
      connected: isConnected,
    });
  }
  for (const providerId of retainedDisconnectedProviderIds) {
    const normalizedId = providerId.toLowerCase();
    if (providerRows.has(normalizedId)) continue;
    const cached = providerDisplayCacheRef.current.get(normalizedId);
    providerRows.set(normalizedId, {
      id: cached?.id ?? providerId,
      name: cached?.name ?? providerId,
      source: cached?.source ?? "config",
      connected: false,
    });
  }
  // TIPS: 排序键必须与连接状态无关。断开后的条目会从引擎列表消失、退回本地缓存
  // 渲染，缓存未命中时名称退化为 provider ID；若按名称排序，条目会在断开瞬间跳到
  // 列表另一处，用户在同一屏幕位置连续点击就会命中另一个模型组。
  const connectedProviders = Array.from(providerRows.entries())
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([, row]) => row);
  const mcpConnectedAppsCount = connectionsSnapshot.mcpServers.length;
  const juggleworkCloudMcpUrl = connectionsSnapshot.mcpServers.find(
    (server) => server.name === "jugglework-cloud",
  )?.config.url ?? null;

  // Build enablement context from all available runtime state.
  const enablementContext = useMemo<EnablementContext>(() => {
    const mcpConfigured = new Set(connectionsSnapshot.mcpServers.map((s) => s.name));
    const connectedProviders = new Set(providerConnectedIds);
    const configuredEnvKeys = new Set(userEnvKeys);
    const loadedPlugins = new Set<string>();
    // Browser plugin detection: check if any configured plugin matches the chrome-devtools name.
    // For now, treat it as loaded if the plugin is in the MCP/plugin list — this will
    // be refined when we add a real plugin-loaded signal from the engine.
    const browserPluginConfigured = connectionsSnapshot.mcpServers.some(
      (s) => s.name === "opencode-chrome-devtools" || s.config.command?.some((c: string) => c.includes("chrome-devtools")),
    );
    if (browserPluginConfigured) loadedPlugins.add("opencode-chrome-devtools");

    return {
      mcpStatuses: connectionsSnapshot.mcpStatuses,
      mcpConfigured,
      loadedPlugins,
      connectedProviders,
      configuredEnvKeys,
      permissions: computerUsePermissions ?? undefined,
      // Toggle state reader for extensions with defaultEnabled / explicit toggle.
      isToggleEnabled: (ref: string) => {
        const catalog = connectionsStore.quickConnect;
        const match = catalog.find((e: { id?: string; serverName?: string }) => (e.id ?? e.serverName) === ref);
        return match ? isJuggleWorkExtensionEnabled(match) : false;
      },
    };
  }, [computerUsePermissions, connectionsSnapshot, extensionStateVersion, providerConnectedIds, userEnvKeys]);
  const builtInExtensionsDisabled = checkDesktopRestriction({ restriction: "allowBuiltInExtensions" });
  const restartExtensionLocalServer = useCallback(async () => {
    if (!isDesktopRuntime()) return false;
    try {
      await juggleworkServerRestart({
        remoteAccessEnabled:
          readJuggleWorkServerSettings().remoteAccessEnabled === true,
      });
      await juggleworkServerStore.reconnectJuggleWorkServer();
      await refreshRouteState();
      return true;
    } catch {
      return false;
    }
  }, [juggleworkServerStore, refreshRouteState]);
  const extensionController = useSettingsExtensionController({
    juggleworkServerClient: selectedWorkspaceEndpoint?.client ?? juggleworkClient,
    hostJuggleWorkServerClient: juggleworkClient,
    enablementContext,
    mcpServers: connectionsSnapshot.mcpServers,
    mcpConnectingName: connectionsSnapshot.mcpConnectingName,
    onComputerUsePermissionsChange: setComputerUsePermissions,
    googleWorkspaceConnected,
    setGoogleWorkspaceConnected,
    restartLocalServer: restartExtensionLocalServer,
    connectMcp: async (entry) => {
      await connectionsStore.connectMcp(entry);
    },
    refreshMcpServers: () => connectionsStore.refreshMcpServers(),
    providers,
    providerConnectedIds,
    userEnvKeys,
    imageExtension: {
      busy: imageExtensionBusy || imageGenerationBusy,
      status: imageExtensionStatus ?? imageGenerationStatus,
      error: imageExtensionError ?? imageGenerationError,
      onInstall: installOpenAiImageExtension,
      onTestGenerate: generateOpenAiTestImage,
    },
    voiceExtension: {
      busy: voiceBusy,
      status: voiceStatus,
      error: voiceError,
      onSaveApiKey: saveVoiceApiKey,
      onTestSession: testVoiceSession,
    },
    localProvider: {
      busy: localProviderBusy,
      status: localProviderStatus,
      error: localProviderError,
      onInstall: installLocalProvider,
    },
  });
  const extensionItems = useMemo(
    () => buildExtensionItems({
      quickConnect: connectionsStore.quickConnect,
      mcpServers: connectionsSnapshot.mcpServers,
      installedSkills: extensionsStore.skills(),
      importedCloudPlugins: extensionsSnapshot.importedCloudPlugins,
      pendingCloudPluginChanges: extensionsSnapshot.pendingCloudPluginChanges,
      cloudMarketplaces: extensionsSnapshot.cloudOrgMarketplaces,
      orgMcpConnections: orgMcpConnections.connections,
      enablementContext,
      isBuiltInConnected: extensionController.isConnected,
    }),
    [connectionsSnapshot.mcpServers, connectionsStore.quickConnect, enablementContext, extensionController, extensionsSnapshot, extensionsStore, orgMcpConnections.connections],
  );
  const organizationConnectionsProbe = resolveOrganizationConnectionsProbe({
    signedIn: cloudSession.isSignedIn,
    activeOrganizationId: cloudSession.activeOrganization?.id,
    loading: orgMcpConnections.loading,
    loaded: orgMcpConnections.loaded,
    error: orgMcpConnections.error,
  });
  const diagnosticsClient = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
  const diagnosticsWorkspaceAllowed = isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace);
  const diagnosticsAvailable = Boolean(
    diagnosticsClient
    && runtimeWorkspaceId?.trim()
    && diagnosticsWorkspaceAllowed,
  );
  const diagnosticsUnavailableReason = selectedWorkspace?.workspaceType === "remote"
    && selectedWorkspace.remoteType !== "jugglework"
    ? "direct-remote-opencode" as const
    : null;
  const diagnosticsWorkspaceType = selectedWorkspace?.workspaceType === "remote"
    ? selectedWorkspace.remoteType ?? "legacy-opencode"
    : "local";
  const diagnosticsScopeKey = useMemo(() => createOpaqueDiagnosticsScopeKey({
    client: diagnosticsClient,
    workspaceCredential: selectedWorkspaceEndpoint?.token ?? token,
    workspaceId: runtimeWorkspaceId?.trim() ?? "",
    workspaceType: diagnosticsWorkspaceType,
    denBaseUrl: cloudSession.baseUrl,
    denCredential: cloudSession.authToken,
    denSignedIn: cloudSession.isSignedIn,
    organizationId: cloudSession.activeOrganization?.id ?? "signed-out",
    principalId: cloudSession.user?.id ?? "signed-out",
  }), [
    cloudSession.activeOrganization?.id,
    cloudSession.authToken,
    cloudSession.baseUrl,
    cloudSession.isSignedIn,
    cloudSession.user?.id,
    diagnosticsClient,
    diagnosticsWorkspaceType,
    runtimeWorkspaceId,
    selectedWorkspaceEndpoint?.token,
    token,
  ]);
  const runAgentContextDiagnostics = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? juggleworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (
      !client
      || !workspaceId
      || !selectedWorkspace
      || !isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace)
    ) {
      throw new Error("Agent diagnostics require a connected workspace.");
    }
    const observations = await collectAgentContextDiagnosticObservations({
      organizationConnections: orgMcpConnections.connections,
      organizationConnectionsProbe,
      workspaceType: selectedWorkspace.workspaceType,
    });
    return client.runAgentContextDiagnostics(workspaceId, observations);
  }, [
    juggleworkClient,
    organizationConnectionsProbe,
    orgMcpConnections.connections,
    runtimeWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
  ]);
  const routeJuggleWorkStatus = juggleworkClient ? "connected" : "disconnected";
  const notFoundRouteError = !loading && routeWorkspaceId && !selectedWorkspace
    ? "Workspace was not found. Select a new workspace from the sidebar."
    : null;
  useEffect(() => {
    if (notFoundRouteError) {
      notifyAlert({
        kind: "system",
        title: notFoundRouteError,
        dedupeKey: "workspace-not-found",
      });
    }
  }, [notFoundRouteError]);
  const routeJuggleWorkCapabilities: JuggleWorkServerCapabilities | null = juggleworkClient
    ? ROUTE_JUGGLEWORK_CAPABILITIES
    : null;
  const environmentRuntimeKey = buildJuggleWorkEnvRuntimeKey({
    baseUrl: juggleworkServerSnapshot.juggleworkServerBaseUrl || juggleworkServerSnapshot.juggleworkServerUrl,
    pid: juggleworkServerSnapshot.juggleworkServerHostInfo?.pid ?? null,
    port: juggleworkServerSnapshot.juggleworkServerHostInfo?.port ?? null,
  });

  const handleApplyEnvironmentChanges = async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const workspacePaths = Array.from(
      new Set(
        workspaces.flatMap((workspace) => {
          const path = workspace.workspaceType !== "remote" ? workspace.path?.trim() ?? "" : "";
          return path ? [path] : [];
        }),
      ),
    );
    const workspacePathSet = new Set(workspacePaths);
    if (!workspacePathSet.has(selectedWorkspaceRoot)) {
      workspacePaths.unshift(selectedWorkspaceRoot);
    }
    await engineStart(selectedWorkspaceRoot, {
      preferSidecar: true,
      runtime: "direct",
      workspacePaths,
      juggleworkRemoteAccess: juggleworkServerSnapshot.juggleworkServerSettings.remoteAccessEnabled === true,
    });
    const reconnected = await juggleworkServerStore.reconnectJuggleWorkServer();
    if (!reconnected) {
      await refreshRouteState().catch(() => {});
      return { statusMessage: t("settings.environment.apply_refresh_failed") };
    }
    await refreshRouteState();
  };

  const openCreateWorkspace = (screen: CreateWorkspaceScreen) => {
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "allowMultipleWorkspaces" })
    ) {
      restrictionNotice.show({
        title: "Additional workspaces are restricted",
        message:
          "Your organization administrator has restricted access to adding additional workspaces.",
      });
      return;
    }

    setCreateWorkspaceError(null);
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceInitialScreen(screen);
    setCreateWorkspaceOpen(true);
  };

  const handleSelectSettingsWorkspace = useCallback((workspaceId: string) => {
    if (workspaceId === selectedWorkspaceId) return;
    setLegacySelectedWorkspaceId(workspaceId);
    writeActiveWorkspaceId(workspaceId);
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    const endpoint = workspaceServerClientResolver(workspace);
    if (endpoint) {
      void endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true }).catch(() => undefined);
    }
    if (isDesktopRuntime()) {
      void workspaceSetSelected(workspaceId).catch(() => undefined);
      void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
    }
    navigate(workspaceSettingsRoute(workspaceId, settingsPathForRoute(route)), { state: location.state });
  }, [location, navigate, route, selectedWorkspaceId, workspaceServerClientResolver, workspaces]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(workspaceLabel(workspace));
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!juggleworkClient) {
        toast.error("JuggleWork server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await juggleworkClient.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [juggleworkClient, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    await revealDesktopItemInDir(path).catch(() => undefined);
  }, [workspaces]);

  const handleExportWorkspaceConfig = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    const endpoint = workspaceServerClientResolver(workspace);
    if (endpoint) {
      setExportWorkspaceBusy(true);
      try {
        const payload = await endpoint.client.exportWorkspace(endpoint.workspaceId);
        downloadWorkspaceJson(workspaceExportFilename(workspace), payload);
      } finally {
        setExportWorkspaceBusy(false);
      }
      return;
    }
    throw new Error("JuggleWork server is unavailable. Reconnect the server before exporting workspace config.");
  }, [workspaceServerClientResolver, workspaces]);

  const handleForgetWorkspace = useCallback(async (workspaceId: string) => {
    if (typeof window !== "undefined") {
      const message = t("workspace_list.remove_confirm") || "Remove this workspace from the sidebar?";
      if (!window.confirm(message)) return;
    }
    if (juggleworkClient) {
      await juggleworkClient.deleteWorkspace(workspaceId).catch(() => undefined);
    }
    if (isDesktopRuntime()) {
      await workspaceForget(workspaceId).catch(() => undefined);
    }
    if (selectedWorkspaceId === workspaceId) {
      const nextWorkspace = workspaces.find((workspace) => workspace.id !== workspaceId);
      const nextId = nextWorkspace?.id ?? "";
      setLegacySelectedWorkspaceId(nextId);
      if (nextId) {
        await workspaceSetSelected(nextId).catch(() => undefined);
      }
    }
    await refreshRouteState();
  }, [juggleworkClient, refreshRouteState, selectedWorkspaceId, workspaces]);

  const handleCreateWorkspace = async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      let list: WorkspaceList | null = null;
      if (juggleworkClient) {
        list = await juggleworkClient
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => null);
      }
      if (!list) {
        throw new Error("JuggleWork server is unavailable. Start or reconnect the server before creating a workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  };

  const handleCreateRemoteWorkspace = async (input: {
    juggleworkHostUrl?: string | null;
    juggleworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const baseUrlValue = input.juggleworkHostUrl?.trim() ?? "";
    if (!baseUrlValue) return false;
    setCreateWorkspaceRemoteBusy(true);
    setCreateWorkspaceRemoteError(null);
    try {
      const remoteType: "jugglework" = "jugglework";
      const payload = {
        baseUrl: baseUrlValue,
        juggleworkHostUrl: baseUrlValue,
        juggleworkToken: input.juggleworkToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType,
      };
      let list: WorkspaceList | null = null;
      if (isDesktopRuntime()) {
        list = await workspaceCreateRemote(payload);
      } else if (juggleworkClient) {
        list = await juggleworkClient.createRemoteWorkspace(payload).catch(() => null);
      }
      if (!list) {
        throw new Error("JuggleWork server is unavailable. Start or reconnect the server before connecting a remote workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  };

  // 只有真正持有路由的设置面板才能改 URL：嵌入式面板自己管路径，隐藏的常驻面板不能抢路由。
  const ownsBrowserRoute = !props.embedded && props.active !== false;

  if (route.redirectPath && ownsBrowserRoute) {
    const target = selectedWorkspaceId
      ? workspaceSettingsRoute(selectedWorkspaceId, route.redirectPath)
      : `/settings/${route.redirectPath}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (ownsBrowserRoute && !routeWorkspaceId && selectedWorkspaceId) {
    return <Navigate to={workspaceSettingsRoute(selectedWorkspaceId, settingsPathForRoute(route))} replace state={location.state} />;
  }

  const openCloudAccountSettings = () => {
    navigateSettingsPath("cloud-account");
  };

  const settingsView = (() => {
    switch (route.tab) {
      case "notifications":
        return <NotificationCenterView />;
      case "general":
        return (
          <GeneralSettingsView
            onNavigateTab={(tab) => navigateSettingsPath(tab)}
            developerMode={developerMode}
            onReportIssue={() => platform.openLink("https://github.com/juggleai/jugglework-desktop/issues/new?template=bug.yml")}
          />
        );
      case "permissions":
        return (
          <SettingsStack>
            <AuthorizedFoldersPanel
              juggleworkServerClient={juggleworkClient}
              juggleworkServerStatus={routeJuggleWorkStatus}
              juggleworkServerCapabilities={routeJuggleWorkCapabilities}
              runtimeWorkspaceId={runtimeWorkspaceId}
              selectedWorkspaceRoot={selectedWorkspaceRoot}
              activeWorkspaceType={workspaceType}
              onConfigUpdated={() => {
                setConfigActionStatus(t("settings.config_updated"));
                void providerAuthStore.refreshProviders();
                void connectionsStore.refreshMcpServers();
              }}
            />
          </SettingsStack>
        );
      case "ai":
        return (
          <AiSettingsView
            busy={busy}
            providerAuthBusy={providerAuthSnapshot.providerAuthBusy}
            connectedProviders={connectedProviders}
            disconnectingProviderId={disconnectingProviderId}
            deletingProviderId={deletingProviderId}
            providerConnectError={providerAuthSnapshot.providerAuthError}
            providerDisconnectError={providerDisconnectError}
            onOpenProviderAuth={handleOpenProviderAuth}
            onEditLocalProvider={async (providerId) => {
              if (checkDesktopRestriction({ restriction: "allowCustomProviders" })) {
                restrictionNotice.show({
                  title: "Editing custom providers is disabled",
                  message: "Your organization administrator has disabled custom providers.",
                });
                return;
              }
              const provider = providers.find((item) => item.id === providerId) ??
                providerDisplayCacheRef.current.get(providerId.trim().toLowerCase());
              const draft = provider ? customProviderInputFromProvider(provider) : null;
              if (!draft) {
                setProviderDisconnectError(t("providers.custom_edit_unsupported"));
                return;
              }
              setProviderDisconnectError(null);
              setEditingLocalProvider(draft);
              providerAuthStore.openCustomProviderModal();
            }}
            onDisconnectProvider={async (providerId) => {
              if (disconnectingProviderId) return;
              setDisconnectingProviderId(providerId);
              setProviderDisconnectError(null);
              setConfigActionStatus(null);
              try {
                const message = await providerAuthStore.disconnectProvider(providerId);
                if (typeof message === "string" && message.trim()) {
                  setConfigActionStatus(message);
                }
              } catch (error) {
                setProviderDisconnectError(
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : t("providers.disconnect_failed"),
                );
              } finally {
                setDisconnectingProviderId(null);
              }
            }}
            onDeleteProvider={async (providerId) => {
              if (deletingProviderId || disconnectingProviderId) return false;
              setDeletingProviderId(providerId);
              setProviderDisconnectError(null);
              setConfigActionStatus(null);
              try {
                const message = await providerAuthStore.deleteProvider(providerId);
                if (typeof message === "string" && message.trim()) {
                  setConfigActionStatus(message);
                }
                providerDisplayCacheRef.current.delete(providerId.trim().toLowerCase());
                return true;
              } catch (error) {
                setProviderDisconnectError(
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : t("providers.delete_failed"),
                );
                return false;
              } finally {
                setDeletingProviderId(null);
              }
            }}
            canDisconnectProvider={(provider) =>
              provider.id.trim().toLowerCase() === "opencode" || provider.source !== "env"
            }
            canDeleteProvider={(provider) =>
              provider.source === "config" || provider.source === "custom"
            }
            reconnectingProviderId={reconnectingProviderId}
            onReconnectProvider={async (providerId) => {
              if (reconnectingProviderId) return;
              setReconnectingProviderId(providerId);
              setProviderDisconnectError(null);
              setConfigActionStatus(null);
              try {
                await providerAuthStore.ensureProjectProviderDisabledState(providerId, false);
                await providerAuthStore.refreshProviders({ dispose: true });
                setConfigActionStatus(`${t("status.connected")} ${providerId}`);
              } catch (error) {
                setProviderDisconnectError(
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : t("providers.request_failed"),
                );
              } finally {
                setReconnectingProviderId(null);
              }
            }}
            cloudProviderIds={new Set(getCurrentCloudManagedProviderIds({
              imported: providerAuthSnapshot.importedCloudProviders ?? {},
              liveProviders: providerAuthSnapshot.cloudOrgProviders,
            }))}
          />
        );
      case "preferences":
        return (
          <PreferencesView
            busy={busy}
            showThinking={local.prefs.showThinking}
            onToggleShowThinking={() => {
              local.setPrefs((previous) => ({ ...previous, showThinking: !previous.showThinking }));
            }}
            autoCompactContext={autoCompactContext}
            autoCompactContextBusy={autoCompactContextBusy}
            onToggleAutoCompactContext={toggleAutoCompactContext}
            analyticsEnabled={local.prefs.analyticsEnabled}
            onToggleAnalytics={() => {
              local.setPrefs((previous) => ({ ...previous, analyticsEnabled: !previous.analyticsEnabled }));
            }}
            desktopNotifications={local.prefs.desktopNotifications}
            onDesktopNotificationsChange={(desktopNotifications) => {
              local.setPrefs((previous) => ({ ...previous, desktopNotifications }));
            }}
            memoryEnabled={memoryEnabled}
            onToggleMemory={toggleMemory}
          />
        );
      case "shell":
        return <ShellCustomizationView />;
      case "skills":
        return (
          <GlobalSkillsView
            busy={busy}
            skills={globalSkills}
            status={extensionsSnapshot.skillsStatus}
            error={globalExtensionsError}
            deletingSkillName={deletingGlobalSkill}
            onDeleteSkill={deleteGlobalSkill}
            onRefresh={() => { void extensionsStore.refreshSkills({ force: true }); }}
            projectDir={selectedWorkspaceRoot}
          />
        );
      case "connectors":
        return (
          <GlobalConnectorsView
            busy={busy}
            connectors={globalConnectors}
            error={globalExtensionsError}
            pendingConnectorName={pendingGlobalConnector}
            onAddConnector={addGlobalConnector}
            onToggleEnabled={toggleGlobalConnector}
            onRemoveConnector={removeGlobalConnector}
            onRefresh={() => { void refreshGlobalConnectors(); }}
          />
        );
      case "extensions": {
        // TIPS: 仅会话右侧 rail（embedded）改为分组卡片面板；独立设置页维持既有 ExtensionsView。
        if (props.embedded) {
          const projectConnectors = buildProjectConnectors({
            mcpServers: connectionsSnapshot.mcpServers,
            mcpStatuses: connectionsSnapshot.mcpStatuses,
            quickConnect: extensionItems.quickConnectEntries,
            orgMcpItems: extensionItems.orgMcpConnectionItems,
            mcpConnectingName: connectionsSnapshot.mcpConnectingName,
            orgMcpConnectingId: orgMcpConnections.connectingId,
            orgMcpDisconnectingId: orgMcpConnections.disconnectingId,
            connectDirectory: (entry) => { void connectionsStore.connectMcp(entry); },
            authorizeMcp: (entry) => { void connectionsStore.authorizeMcp(entry); },
            removeMcp: (name) => { void connectionsStore.removeMcp(name); },
            setMcpEnabled: (name, enabled) => { void connectionsStore.setMcpEnabled(name, enabled); },
            connectOrg: (connectionId) => { void orgMcpConnections.connect(connectionId); },
            disconnectOrg: (connectionId) => { void orgMcpConnections.disconnect(connectionId); },
          });
          // TIPS: 技能弹窗的数据源 = 完整技能列表（本工作区 + 全局，带 scope）按工作区过滤。
          // 不能用 extensionItems.installedSkills：那份列表会把「属于某个云端市场包」的技能
          // 剔除（旧扩展页把它们折叠进插件卡片），导致刚安装到工作区的市场技能不显示。
          // 全局技能已拆到设置页的「技能」，这里只保留工作区技能。
          const projectSkills = extensionsSnapshot.skills.filter((skill) => skill.scope !== "global");
          return (
            <ProjectExtensionsPanel
              projectDir={selectedWorkspaceRoot}
              isRemoteWorkspace={isRemoteWorkspace}
              busy={busy}
              connectors={projectConnectors}
              connectorError={orgMcpConnections.error}
              onAddCustomMcp={async (entry) => { await connectionsStore.connectMcp(entry); }}
              configSlotForConnector={extensionController.configSlotForEntry}
              installedSkills={projectSkills}
              pluginsSlot={({ search }) => (
                <CloudMarketplacesView
                  extensions={extensionsStore}
                  onOpenAccount={openCloudAccountSettings}
                  session={denSession}
                  hideSectionHeader
                  hideMarketplaceFilter
                  uniformCardHeight
                  plainCards
                  searchValue={search}
                />
              )}
              onRefreshPlugins={async () => {
                denSession.syncCurrentDenSettings();
                await extensionsStore.refreshCloudOrgMarketplaces({ force: true });
              }}
              onUninstallSkill={(name) => { void extensionsStore.uninstallSkill(name); }}
              onRefreshSkills={() => { void extensionsStore.refreshSkills({ force: true }); }}
              onUploadSkill={async () => {
                const dir = (await pickDirectory({ title: t("project_extensions.upload_skill") })) as string | null;
                if (!dir) return;
                await importSkill(selectedWorkspaceRoot, dir, { overwrite: false });
                await extensionsStore.refreshSkills({ force: true });
              }}
            />
          );
        }
        return (
          <ExtensionsView
            busy={busy}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            isRemoteWorkspace={isRemoteWorkspace}
            canEditPlugins={canWriteWorkspacePlugins}
            canManageLocalSkills={!isRemoteWorkspace && isDesktopRuntime()}
            canUseGlobalScope={!isRemoteWorkspace}
            accessHint={pluginsAccessHint}
            suggestedPlugins={SUGGESTED_PLUGINS}
            extensions={extensionsStore}
            mcpConnectedAppsCount={mcpConnectedAppsCount}
            initialSection={route.extensionsSection}
            setSectionRoute={(section) => {
              const path = `extensions/${section}`;
              navigateSettingsPath(path);
            }}
            onRefresh={() => {
              // Force-sync the cloud MCP first (re-mint token + rewrite
              // config, bypassing the freshness marker) so Refresh really
              // means "make everything current now", then refresh the rest.
              void connectionsStore.syncCloudControlMcp({ force: true }).then(() => {
                void connectionsStore.refreshMcpServers();
              });
              void extensionsStore.refreshPlugins();
              void extensionsStore.refreshCloudOrgMarketplaces({ force: true });
              void orgMcpConnections.refresh();
              void refreshConnectCapabilities();
            }}
            mcpView={
              <McpView
                busy={busy}
                selectedWorkspaceRoot={selectedWorkspaceRoot}
                isRemoteWorkspace={isRemoteWorkspace}
                mcpServers={connectionsSnapshot.mcpServers}
                mcpStatus={connectionsSnapshot.mcpStatus}
                mcpLastUpdatedAt={connectionsSnapshot.mcpLastUpdatedAt}
                mcpStatuses={connectionsSnapshot.mcpStatuses}
                mcpConnectingName={connectionsSnapshot.mcpConnectingName}
                selectedMcp={connectionsSnapshot.selectedMcp}
                setSelectedMcp={(name) => connectionsStore.setSelectedMcp(name)}
                quickConnect={extensionItems.quickConnectEntries}
                enablementContext={enablementContext}
                builtInExtensionsDisabled={builtInExtensionsDisabled}
                connectMcp={(entry) => {
                  void connectionsStore.connectMcp(entry);
                }}
                configSlotForEntry={extensionController.configSlotForEntry}
                isExtensionConnected={extensionController.isConnected}
                authorizeMcp={(entry) => {
                  void connectionsStore.authorizeMcp(entry);
                }}
                logoutMcpAuth={(name) => connectionsStore.logoutMcpAuth(name)}
                removeMcp={(name) => {
                  void connectionsStore.removeMcp(name);
                }}
                setMcpEnabled={
                  routeJuggleWorkStatus === "connected" && routeJuggleWorkCapabilities?.mcp?.write
                    ? (name, enabled) => connectionsStore.setMcpEnabled(name, enabled)
                    : undefined
                }
                readConfigFile={(scope) => connectionsStore.readMcpConfigFile(scope)}
                installedSkills={[
                  ...extensionItems.installedSkills,
                  ...connectCapabilities.skills.filter(
                    (skill) => !extensionItems.installedSkills.some(
                      (installed) => installed.name.toLowerCase() === skill.name.toLowerCase(),
                    ),
                  ),
                ]}
                availableConnectMcpServers={connectCapabilities.mcpServers.filter(
                  (entry) => !extensionItems.orgMcpConnectionItems.some((item) =>
                    item.name.localeCompare(entry.name, undefined, { sensitivity: "accent" }) === 0
                  ),
                )}
                availableConnectMcpStatuses={connectCapabilities.mcpStatuses}
                installedPlugins={extensionItems.installedCloudPlugins}
                orgMcpItems={extensionItems.orgMcpConnectionItems}
                orgMcpConnectingId={orgMcpConnections.connectingId}
                uninstallSkill={(name) => { void extensionsStore.uninstallSkill(name); }}
                removeCloudPlugin={(pluginId) => { void extensionsStore.removeCloudOrgPlugin(pluginId); }}
                orgMcpDisconnectingId={orgMcpConnections.disconnectingId}
                connectOrgMcp={(connectionId) => { void orgMcpConnections.connect(connectionId); }}
                disconnectOrgMcp={(connectionId) => { void orgMcpConnections.disconnect(connectionId); }}
                readSkill={(name) => extensionsStore.readSkill(name)}
                previewClaudePlugin={(url) => extensionsStore.previewClaudePlugin(url)}
                installClaudePlugin={(url) => extensionsStore.installClaudePlugin(url)}
                showHeader={false}
              />
            }
            marketplaceView={
              <CloudMarketplacesView
                extensions={extensionsStore}
                onOpenAccount={openCloudAccountSettings}
                session={denSession}
              />
            }

          />
        );
      }
      case "cloud-account":
        return (
          <CloudAccountView
            developerMode={developerMode}
            session={denSession}
          />
        );
      case "connect":
        return (
          <ConnectView
            developerMode={developerMode}
            session={denSession}
            juggleworkClient={selectedWorkspaceEndpoint?.client ?? juggleworkClient}
            workspaceId={runtimeWorkspaceId}
            currentModel={currentCloudMcpModel}
            onCloudMcpHealthChange={setCloudMcpHealth}
            orgMcpConnections={orgMcpConnections}
          />
        );
      case "memory":
        return <MemoryView onOpenAccount={openCloudAccountSettings} />;
      case "cloud-providers":
        return (
          <CloudProvidersView
            cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
            connectCloudProvider={providerAuthStore.connectCloudProvider}
            importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
            onOpenAccount={openCloudAccountSettings}
            refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
            refreshImportedCloudProviders={providerAuthStore.refreshImportedCloudProviders}
            removeCloudProvider={providerAuthStore.removeCloudProvider}
            session={denSession}
          />
        );
      case "advanced":
        return (
          <AdvancedView
            busy={busy}
            developerMode={developerMode}
            toggleDeveloperMode={() => setDeveloperMode((current) => {
              const next = !current;
              try { window.localStorage.setItem("jugglework.developerMode", next ? "1" : "0"); } catch {}
              return next;
            })}
          />
        );
      case "appearance":
        return (
          <AppearanceView
            busy={busy}
            themeMode={themeMode}
            setThemeMode={setThemeModeState}
            language={currentLocale() as Language}
            setLanguage={setLocale}
          />
        );
      case "updates":
        return (
          <UpdatesView
            busy={busy}
            webDeployment={platform.platform === "web"}
            appVersion={electronUpdaterState.appVersion}
            updateEnv={electronUpdaterState.updateEnv}
            updateAutoCheck={updateAutoCheck}
            toggleUpdateAutoCheck={() => setUpdateAutoCheck((current) => !current)}
            updateAutoDownload={updateAutoDownload}
            toggleUpdateAutoDownload={() => setUpdateAutoDownload((current) => !current)}
            updateStatus={electronUpdaterState.updateStatus}
            anyActiveRuns={activeReloadBlockingSessions.length > 0}
            checkForUpdates={electronUpdaterState.checkForUpdates}
            downloadUpdate={electronUpdaterState.downloadUpdate}
            installUpdateAndRestart={electronUpdaterState.installUpdateAndRestart}
            onToggleDebug={() => {
              setDeveloperMode((current) => {
                const next = !current;
                try { window.localStorage.setItem("jugglework.developerMode", next ? "1" : "0"); } catch {}
                return next;
              });
            }}
          />
        );
      case "recovery":
        return (
          <RecoveryView
            anyActiveRuns={false}
            workspaceConfigPath={selectedWorkspaceRoot ? `${selectedWorkspaceRoot}/.opencode/jugglework.json` : ""}
            resetConfigBusy={resetConfigBusy}
            onResetAppConfigDefaults={() => {}}
            configActionStatus={configActionStatus}
            cacheRepairBusy={false}
            cacheRepairResult={null}
            onRepairOpencodeCache={() => {}}
            dockerCleanupBusy={false}
            dockerCleanupResult={null}
            onCleanupJuggleWorkDockerContainers={() => {}}
          />
        );
      case "environment":
        return (
          <EnvironmentView
            client={juggleworkServerSnapshot.juggleworkServerClient}
            isRemoteWorkspace={isRemoteWorkspace}
            onApplyChanges={isDesktopRuntime() && !isRemoteWorkspace ? handleApplyEnvironmentChanges : undefined}
            applyBlocked={activeReloadBlockingSessions.length > 0}
            applyBlockedReason={
              activeReloadBlockingSessions.length > 0
                ? t("settings.environment.apply_blocked_active_tasks")
                : null
            }
            runtimeKey={environmentRuntimeKey}
          />
        );
      case "debug":
        return (
          <DebugView
            {...debugViewProps}
            agentContextDiagnostics={{
              scopeKey: diagnosticsScopeKey,
              available: diagnosticsAvailable,
              unavailableReason: diagnosticsUnavailableReason,
              onRun: runAgentContextDiagnostics,
            }}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <>
      <SettingsShell
        activeTab={route.tab}
        onSelectTab={(tab) => navigateSettingsPath(tab)}
        developerMode={developerMode}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedWorkspaceName={selectedWorkspaceName}
        selectedWorkspaceColor={selectedWorkspaceColor}
        workspaces={workspaceOptions}
        onSelectWorkspace={handleSelectSettingsWorkspace}
        onOpenAccount={openCloudAccountSettings}
        onOpenHome={props.onClose ?? (() => navigate(
          settingsReturnRoute(
            selectedWorkspaceId,
            navigationWorkspaceId,
            navigationSessionId,
            readLastSessionFor(selectedWorkspaceId),
          ),
        ))}
        onOpenApps={() => navigate(workspaceAppsRoute(selectedWorkspaceId))}
        onOpenChat={() => navigate(workspaceChatRoute(selectedWorkspaceId))}
        onOpenTaskSearch={() => setCommandPaletteOpen(true)}
        onOpenCreateWorkspace={(screen = "chooser") => openCreateWorkspace(screen)}
        headerStatus={routeJuggleWorkStatus}
        busyHint={loading ? t("session.loading_detail") : busyLabel}
        onClose={props.onClose ?? (() => navigate(
          navigationReturnPath ?? settingsReturnRoute(
            selectedWorkspaceId,
            navigationWorkspaceId,
            navigationSessionId,
            readLastSessionFor(selectedWorkspaceId),
          ),
        ))}
        compact={props.embedded}
        contentOnly={props.contentOnly}
        compactTitle={Boolean(props.embedded) && route.tab === "extensions" ? t("project_extensions.panel_title") : undefined}
        hideHeading={Boolean(props.embedded) && route.tab === "extensions"}
      >
        {settingsView}
      </SettingsShell>

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onCreateNewSession={() => void handleCreatePaletteSession()}
        onOpenSession={(workspaceId, sessionId) => {
          navigate(workspaceSessionRoute(workspaceId, sessionId));
        }}
        onOpenSettings={(path = "/settings/preferences") => {
          navigateSettingsPath(path.replace(/^\/settings\//, ""));
        }}
        onOpenModelPicker={() => {
          modelPicker.setQuery("");
          modelPicker.setRecentProviderIds(new Set());
          window.requestAnimationFrame(() => modelPicker.setOpen(true));
        }}
        selectedModelLabel={defaultModelLabel}
        sessions={paletteSessionOptions}
      />

      <ProviderAuthModal
        open={providerAuthSnapshot.providerAuthModalOpen}
        loading={false}
        submitting={providerAuthSnapshot.providerAuthBusy}
        error={providerAuthSnapshot.providerAuthError}
        preferredProviderId={providerAuthSnapshot.providerAuthPreferredProviderId}
        workerType={providerAuthSnapshot.providerAuthWorkerType}
        // Hide any provider the org blocks at the desktop layer so users
        // can't connect a forbidden one (dev #1505). Same helper covers
        // opencode-provider gating via the `allowZenModel` restriction and
        // the connected cloud's `allowedModels` catalog.
        // We also strip the matching key from `authMethods` because the
        // modal builds its entry list from `Object.keys(authMethods)`,
        // not from `providers`.
        providers={providerAuthSnapshot.providerAuthProviders.filter(
          (provider) =>
            !isProviderHiddenFromConnectUi(provider.id) &&
            !isDesktopProviderBlocked({
              providerId: provider.id,
              checkRestriction: checkDesktopRestriction,
              allowedModels,
            }),
        )}
        connectedProviderIds={providerConnectedIds}
        authMethods={Object.fromEntries(
          Object.entries(providerAuthSnapshot.providerAuthMethods).filter(
            ([providerId]) =>
              !isProviderHiddenFromConnectUi(providerId) &&
              !isDesktopProviderBlocked({
                providerId,
                checkRestriction: checkDesktopRestriction,
                allowedModels,
              }),
          ),
        )}
        onSelect={providerAuthStore.startProviderAuth}
        onSubmitApiKey={providerAuthStore.submitProviderApiKey}
        onConnectCustomProvider={providerAuthStore.connectCustomProvider}
        customProviderDraft={editingLocalProvider}
        onConnectCloudProvider={providerAuthStore.connectCloudProvider}
        onSubmitOAuth={providerAuthStore.completeProviderAuthOAuth}
        onRefreshProviders={providerAuthStore.refreshProviders}
        onClose={() => {
          setEditingLocalProvider(null);
          providerAuthStore.closeProviderAuthModal();
        }}
      />
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        initialScreen={createWorkspaceInitialScreen}
        onClose={() => {
          setCreateWorkspaceOpen(false);
          setCreateWorkspaceError(null);
        }}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemoteWorkspace}
        onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
        submitting={createWorkspaceBusy}
        localError={createWorkspaceError}
        showProjectLabel={false}
        remoteSubmitting={createWorkspaceRemoteBusy}
        remoteError={createWorkspaceRemoteError}
      />
      <RenameWorkspaceModal
        open={renameWorkspaceId !== null}
        title={renameWorkspaceTitle}
        busy={renameWorkspaceBusy}
        canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
        onClose={() => {
          if (renameWorkspaceBusy) return;
          setRenameWorkspaceId(null);
          setRenameWorkspaceTitle("");
        }}
        onSave={() => void handleSaveRenameWorkspace()}
        onTitleChange={setRenameWorkspaceTitle}
      />
      {shareWorkspaceState.shareWorkspaceOpen ? (
        <ShareWorkspaceModal
          open
          onClose={shareWorkspaceState.closeShareWorkspace}
          workspaceName={shareWorkspaceState.shareWorkspaceName}
          workspaceDetail={shareWorkspaceState.shareWorkspaceDetail}
          fields={shareWorkspaceState.shareFields}
          note={shareWorkspaceState.shareNote}
          onExportConfig={
            shareWorkspaceState.exportDisabledReason === null
              ? () => {
                  const id = shareWorkspaceState.shareWorkspaceId;
                  if (!id) return;
                  void handleExportWorkspaceConfig(id);
                }
              : undefined
          }
          exportDisabledReason={shareWorkspaceState.exportDisabledReason}
        />
      ) : null}
      <CreateRemoteWorkspaceModal
        open={remoteWorkspaceConnectionEditor.workspace !== null}
        onClose={remoteWorkspaceConnectionEditor.close}
        onConfirm={(input) => void remoteWorkspaceConnectionEditor.save(input)}
        initialValues={remoteWorkspaceConnectionEditor.initialValues}
        submitting={remoteWorkspaceConnectionEditor.busy}
        error={remoteWorkspaceConnectionEditor.error}
        title={t("dashboard.edit_remote_workspace_title")}
        subtitle={t("dashboard.edit_remote_workspace_subtitle")}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm")}
      />
      <ConnectionsModals
        client={activeClient}
        projectDir={selectedWorkspaceRoot}
        reloadBlocked={activeReloadBlockingSessions.length > 0}
        activeSessions={activeReloadBlockingSessions}
        isRemoteWorkspace={selectedWorkspace?.workspaceType === "remote"}
        onForceStopSession={async (sessionId) => {
          if (!activeClient) return;
          await abortSessionSafe(activeClient, sessionId);
        }}
        onReloadEngine={reloadCoordinator.reloadWorkspaceEngine}
        modalState={{
          mcpAuthModalOpen: connectionsSnapshot.mcpAuthModalOpen,
          mcpAuthEntry: connectionsSnapshot.mcpAuthEntry,
          mcpAuthNeedsReload: connectionsSnapshot.mcpAuthNeedsReload,
        }}
        onCloseMcpAuthModal={() => connectionsStore.closeMcpAuthModal()}
        onCompleteMcpAuthModal={() => connectionsStore.completeMcpAuthModal()}
      />
      <ModelPickerModal
        open={modelPicker.open}
        options={modelPicker.options}
        query={modelPicker.query}
        setQuery={modelPicker.setQuery}
        target="default"
        current={
          local.prefs.defaultModel ?? { providerID: "", modelID: "" }
        }
        onSelect={(next: ModelRef) => {
          local.setPrefs((prev) => ({
            ...prev,
            defaultModel: next,
            modelVariant: prev.defaultModel?.providerID === next.providerID && prev.defaultModel.modelID === next.modelID
              ? prev.modelVariant
              : null,
          }));
          modelPicker.setOpen(false);
        }}
        onBehaviorChange={() => {}}
        onOpenSettings={() => {
          // Already inside settings, so switch to the providers tab rather
          // than leaving the button dead.
          modelPicker.setOpen(false);
          navigateSettingsPath("ai");
        }}
        onClose={() => modelPicker.setOpen(false)}
      />
    </>
  );
}

export function SettingsRoute(props: SettingsSurfaceProps = {}) {
  return <SettingsSurface {...props} />;
}

export function SettingsSurface(props: SettingsSurfaceProps) {
  return (
    <CloudSessionProvider>
      <SettingsRouteContent {...props} />
    </CloudSessionProvider>
  );
}
