/** @jsxImportSource react */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AutomationSidebarPreview } from "@/react-app/domains/automations/automation-sidebar-preview";
import {
  CustomizationCatalogSidebar,
  type CustomizationCatalogSection,
  type CustomizationInstalledItem,
} from "@/react-app/domains/settings/shell/customization-catalog-sidebar";
import { useUiStateStore } from "./ui-state-store";
import { appInsetSidebarCssWidth } from "./workspace-shell-layout";
import { workspaceAppsRoute } from "./workspace-routes";
import type { TaskScope } from "@/react-app/domains/session/sidebar/task-scope-store";
import { ToonFactoryProjectSidebar, type ToonFactorySidebarRegistration } from "./toon-factory-sidebar";

export type AppNavigationSidebarPreviewTarget = "automation" | "plugins" | "toon-factory";
const CLOSE_DELAY = 120;

type PreviewContextValue = {
  target: AppNavigationSidebarPreviewTarget | null;
  workspaceTarget: TaskScope | null;
  enabled: boolean;
  onTriggerChange: (target: AppNavigationSidebarPreviewTarget, open: boolean) => void;
  onWorkspaceTriggerChange: (target: TaskScope, open: boolean) => void;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  closePreview: () => void;
  publishPluginItems: (items: CustomizationInstalledItem[]) => void;
  publishToonFactorySidebar: (registration: ToonFactorySidebarRegistration | null) => void;
};

const PreviewContext = createContext<PreviewContextValue>({
  target: null,
  workspaceTarget: null,
  enabled: false,
  onTriggerChange: () => undefined,
  onWorkspaceTriggerChange: () => undefined,
  onPreviewEnter: () => undefined,
  onPreviewLeave: () => undefined,
  closePreview: () => undefined,
  publishPluginItems: () => undefined,
  publishToonFactorySidebar: () => undefined,
});

export function AppNavigationSidebarPreviewProvider(props: { children: ReactNode }) {
  const location = useLocation();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const [target, setTarget] = useState<AppNavigationSidebarPreviewTarget | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState<TaskScope | null>(null);
  const [pluginItems, setPluginItems] = useState<CustomizationInstalledItem[]>([]);
  const [toonFactorySidebar, setToonFactorySidebar] = useState<ToonFactorySidebarRegistration | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      if (!pointerInsideRef.current) {
        setTarget(null);
        setWorkspaceTarget(null);
      }
      closeTimerRef.current = null;
    }, CLOSE_DELAY);
  }, [cancelClose]);
  const onTriggerChange = useCallback((nextTarget: AppNavigationSidebarPreviewTarget, open: boolean) => {
    if (sidebarOpen) return;
    if (open) {
      cancelClose();
      setWorkspaceTarget(null);
      setTarget(nextTarget);
    } else {
      scheduleClose();
    }
  }, [cancelClose, scheduleClose, sidebarOpen]);
  const onWorkspaceTriggerChange = useCallback((nextTarget: TaskScope, open: boolean) => {
    if (sidebarOpen) return;
    if (open) {
      cancelClose();
      setTarget(null);
      setWorkspaceTarget(nextTarget);
    } else {
      scheduleClose();
    }
  }, [cancelClose, scheduleClose, sidebarOpen]);
  const onPreviewEnter = useCallback(() => {
    pointerInsideRef.current = true;
    cancelClose();
  }, [cancelClose]);
  const onPreviewLeave = useCallback(() => {
    pointerInsideRef.current = false;
    scheduleClose();
  }, [scheduleClose]);
  const closePreview = useCallback(() => {
    cancelClose();
    pointerInsideRef.current = false;
    setTarget(null);
    setWorkspaceTarget(null);
  }, [cancelClose]);
  const publishPluginItems = useCallback((items: CustomizationInstalledItem[]) => setPluginItems(items), []);
  const publishToonFactorySidebar = useCallback((registration: ToonFactorySidebarRegistration | null) => setToonFactorySidebar(registration), []);

  useEffect(() => () => cancelClose(), [cancelClose]);
  useEffect(() => {
    cancelClose();
    pointerInsideRef.current = false;
    setTarget(null);
    setWorkspaceTarget(null);
  }, [cancelClose, location.pathname, sidebarOpen]);

  const value = useMemo<PreviewContextValue>(() => ({
    target: sidebarOpen ? null : target,
    workspaceTarget: sidebarOpen ? null : workspaceTarget,
    enabled: !sidebarOpen,
    onTriggerChange,
    onWorkspaceTriggerChange,
    onPreviewEnter,
    onPreviewLeave,
    closePreview,
    publishPluginItems,
    publishToonFactorySidebar,
  }), [closePreview, onPreviewEnter, onPreviewLeave, onTriggerChange, onWorkspaceTriggerChange, publishPluginItems, publishToonFactorySidebar, sidebarOpen, target, workspaceTarget]);

  return (
    <PreviewContext.Provider value={value}>
      {props.children}
      {!sidebarOpen && target ? (
        <AppNavigationSidebarPreviewHost
          target={target}
          pluginItems={pluginItems}
          toonFactorySidebar={toonFactorySidebar}
          onMouseEnter={onPreviewEnter}
          onMouseLeave={onPreviewLeave}
        />
      ) : null}
    </PreviewContext.Provider>
  );
}

export function useAppNavigationSidebarPreview() {
  return use(PreviewContext);
}

export function usePublishAppNavigationPluginItems(items: CustomizationInstalledItem[] | null) {
  const { publishPluginItems } = use(PreviewContext);
  useEffect(() => {
    if (items) publishPluginItems(items);
  }, [items, publishPluginItems]);
}

export function usePublishToonFactorySidebar(registration: ToonFactorySidebarRegistration | null) {
  const { publishToonFactorySidebar } = use(PreviewContext);
  useEffect(() => {
    publishToonFactorySidebar(registration);
    return () => publishToonFactorySidebar(null);
  }, [publishToonFactorySidebar, registration]);
}

function AppNavigationSidebarPreviewHost(props: {
  target: AppNavigationSidebarPreviewTarget;
  pluginItems: CustomizationInstalledItem[];
  toonFactorySidebar: ToonFactorySidebarRegistration | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const width = useUiStateStore((state) => state.workspaceLeftSidebarWidth);
  const [pluginSection, setPluginSection] = useState<CustomizationCatalogSection>("plugins");
  const workspaceId = location.pathname.match(/^\/workspace\/([^/]+)/)?.[1];
  const openPluginSection = (section: CustomizationCatalogSection) => {
    setPluginSection(section);
    navigate(workspaceId ? workspaceAppsRoute(decodeURIComponent(workspaceId)) : "/apps", {
      state: { customizationSection: section, customizationPreviewNonce: Date.now() },
    });
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-1.5 left-[52px] top-11 z-[60] overflow-hidden rounded-[18px] shadow-[0_18px_48px_rgba(15,23,42,0.18)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.42)] mac:titlebar-no-drag"
      style={{ width: appInsetSidebarCssWidth(width) }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      data-app-navigation-sidebar-preview={props.target}
    >
      {props.target === "automation" ? <AutomationSidebarPreview /> : props.target === "toon-factory" ? (
        props.toonFactorySidebar ? <ToonFactoryProjectSidebar preview {...props.toonFactorySidebar} /> : null
      ) : (
        <CustomizationCatalogSidebar
          preview
          activeSection={pluginSection}
          installedItems={props.pluginItems}
          onSelectSection={openPluginSection}
          onSelectInstalledItem={(item) => openPluginSection(item.section)}
        />
      )}
    </div>
  );
}
