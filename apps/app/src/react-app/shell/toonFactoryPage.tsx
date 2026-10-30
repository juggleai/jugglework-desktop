/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  revealDesktopItemInDir,
  toonFactoryChooseProject,
  toonFactoryHide,
  toonFactoryLayout,
  toonFactoryOpen,
  toonFactoryOpenProject,
  toonFactoryAuthorizeProject,
  toonFactoryProjectState,
  toonFactoryRemoveProject,
  toonFactoryRenameProject,
  toonFactoryRestart,
  toonFactorySnapshot,
  toonFactoryStatus,
  toonFactoryEnter,
} from "@/app/lib/desktop";
import type { ToonFactoryProject } from "@/app/lib/desktop-types";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppNavigationRail } from "./app-navigation-rail";
import { AppInsetSurface } from "./app-inset-surface";
import { AppSecondarySidebarResizeHandle } from "./app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "./app-secondary-sidebar-top-controls";
import { useAppNavigationSidebarPreview, usePublishToonFactorySidebar } from "./app-navigation-sidebar-preview";
import { ToonFactoryProjectDialog, ToonFactoryProjectSidebar } from "./toon-factory-sidebar";
import { useUiStateStore } from "./ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "./workspace-shell-layout";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ToonFactoryPage(props: {
  workspaceId: string; onOpenAccount: () => void; onOpenHome: () => void;
  onOpenApps: () => void; onOpenChat: () => void; onOpenReviews: () => void; onOpenSettings: () => void;
  onOpenTaskSearch?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [projects, setProjects] = useState<ToonFactoryProject[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [reauthorizeDirectory, setReauthorizeDirectory] = useState<string | null>(null);
  const [hostOverlaySnapshot, setHostOverlaySnapshot] = useState("");
  const [blockingOverlayOpen, setBlockingOverlayOpen] = useState(false);
  const snapshotRequest = useRef(0);
  const desktop = isDesktopRuntime();
  const sidebarOpen = useUiStateStore(state => state.sidebarOpen);
  const toggleSidebar = useUiStateStore(state => state.toggleSidebar);
  const navigationPreview = useAppNavigationSidebarPreview();
  const navigationPreviewOpen = navigationPreview.target !== null || navigationPreview.workspaceTarget !== null;
  const hostOverlayOpen = navigationPreviewOpen || blockingOverlayOpen;
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = { "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth) } as CSSProperties;
  const applyProjectState = useCallback((state: { projects: ToonFactoryProject[]; currentDirectory: string | null }) => {
    setProjects(state.projects);
    setCurrentDirectory(state.currentDirectory);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    return () => { void toonFactoryHide().catch(() => {}); };
  }, [desktop]);
  useEffect(() => () => { snapshotRequest.current += 1; }, []);
  useEffect(() => {
    let active = true;
    setReady(false); setError("");
    if (!desktop) { setError(t("navigation.toon_factory_desktop_required")); return; }
    const launch = attempt === 0 ? toonFactoryOpen : toonFactoryRestart;
    void launch(props.workspaceId).then(() => toonFactoryEnter()).then((state) => {
      if (!active) return;
      applyProjectState(state);
      setReady(true);
    }).catch(async (error) => {
      if (!active) return;
      if (errorMessage(error).includes("[DIRECTORY_GRANT_REQUIRED]")) {
        try {
          const state = await toonFactoryProjectState();
          if (!active) return;
          if (state.currentDirectory) {
            applyProjectState(state);
            setReauthorizeDirectory(state.currentDirectory);
            setProjectDialogOpen(true);
            setReady(true);
            return;
          }
        } catch {}
      }
      if (active) setError(errorMessage(error));
    });
    const timer = window.setInterval(() => {
      void toonFactoryStatus().then((status) => { if (active && status.error) { setReady(false); setError(status.error); } }).catch(() => {});
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [props.workspaceId, attempt, desktop, applyProjectState]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const refresh = () => { void toonFactoryProjectState().then(state => { if (active) applyProjectState(state); }).catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [applyProjectState, ready]);
  const openProject = useCallback(async (directory: string) => {
    if (projectBusy) return false;
    setProjectBusy(true);
    try {
      const result = await toonFactoryOpenProject(directory);
      applyProjectState(result);
      return true;
    } catch (projectError) {
      if (errorMessage(projectError).includes("[DIRECTORY_GRANT_REQUIRED]")) {
        setReauthorizeDirectory(directory);
        setProjectDialogOpen(true);
        return false;
      }
      toast.error(errorMessage(projectError));
      return false;
    } finally {
      setProjectBusy(false);
    }
  }, [applyProjectState, projectBusy]);
  const chooseProjectFolder = useCallback(async () => {
    if (projectBusy) return;
    setProjectBusy(true);
    try {
      const result = reauthorizeDirectory
        ? await toonFactoryAuthorizeProject(reauthorizeDirectory)
        : await toonFactoryChooseProject();
      if (!result) return;
      applyProjectState(result);
      toast.success(reauthorizeDirectory
        ? "已重新授权并打开项目"
        : result.mode === "imported" ? "已导入漫剧项目" : "已新建漫剧项目");
      setProjectDialogOpen(false);
      setReauthorizeDirectory(null);
    } catch (projectError) {
      toast.error(errorMessage(projectError));
    } finally {
      setProjectBusy(false);
    }
  }, [applyProjectState, projectBusy, reauthorizeDirectory]);
  const renameProject = useCallback(async (directory: string, name: string) => {
    if (projectBusy) return false;
    setProjectBusy(true);
    try {
      applyProjectState(await toonFactoryRenameProject(directory, name));
      return true;
    } catch (projectError) {
      toast.error(errorMessage(projectError));
      return false;
    } finally {
      setProjectBusy(false);
    }
  }, [applyProjectState, projectBusy]);
  const removeProject = useCallback(async (directory: string) => {
    if (projectBusy) return false;
    setProjectBusy(true);
    try {
      applyProjectState(await toonFactoryRemoveProject(directory));
      return true;
    } catch (projectError) {
      toast.error(errorMessage(projectError));
      return false;
    } finally {
      setProjectBusy(false);
    }
  }, [applyProjectState, projectBusy]);
  const revealProject = useCallback(async (directory: string) => {
    try {
      await revealDesktopItemInDir(directory);
    } catch (projectError) {
      toast.error(errorMessage(projectError));
    }
  }, []);
  const sidebarRegistration = useMemo(() => ({
    projects,
    currentDirectory,
    busy: projectBusy,
    onOpenProject: (directory: string) => { void openProject(directory); },
    onRenameProject: renameProject,
    onRevealProject: revealProject,
    onRemoveProject: removeProject,
    onRequestCreate: () => { setReauthorizeDirectory(null); setProjectDialogOpen(true); },
  }), [currentDirectory, openProject, projectBusy, projects, removeProject, renameProject, revealProject]);
  usePublishToonFactorySidebar(sidebarRegistration);
  useEffect(() => {
    const update = () => {
      const open = [...document.querySelectorAll('[role="dialog"], [role="menu"], [data-jugglework-toast]')]
        .some(node => node.getClientRects().length > 0);
      setBlockingOverlayOpen(current => current === open ? current : open);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-jugglework-toast"] });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ready) return;
    const request = ++snapshotRequest.current;
    if (!hostOverlayOpen) {
      const rect = container.current?.getBoundingClientRect();
      if (!rect) return;
      void toonFactoryLayout({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: sidebarOpen ? 0 : 17,
      }).then(() => {
        if (snapshotRequest.current === request) setHostOverlaySnapshot("");
      }).catch(() => {});
      return;
    }
    void toonFactorySnapshot().then(async (snapshot) => {
      const image = new Image();
      image.src = snapshot;
      await image.decode().catch(() => {});
      if (snapshotRequest.current !== request) return;
      setHostOverlaySnapshot(snapshot);
    }).catch(() => {});
  }, [hostOverlayOpen, ready, sidebarOpen]);
  useEffect(() => {
    if (!hostOverlayOpen || !hostOverlaySnapshot) return;
    const frame = requestAnimationFrame(() => { void toonFactoryLayout(null).catch(() => {}); });
    return () => cancelAnimationFrame(frame);
  }, [hostOverlayOpen, hostOverlaySnapshot]);
  useEffect(() => {
    if (!ready || !container.current) return;
    let active = true;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = container.current?.getBoundingClientRect();
        const floatingOverlays = document.querySelectorAll([
          '[role="menu"]',
          '[data-app-navigation-sidebar-preview]',
          '[data-session-list-preview="true"]',
          '[data-app-rail-tooltip]',
        ].join(", "));
        let visibleLeft = rect?.left ?? 0;
        let nonLeftOverlayOpen = false;
        if (rect) {
          for (const node of floatingOverlays) {
            if (node.getClientRects().length === 0) continue;
            const overlayRect = node.getBoundingClientRect();
            const intersects = overlayRect.right > rect.left
              && overlayRect.left < rect.right
              && overlayRect.bottom > rect.top
              && overlayRect.top < rect.bottom;
            if (!intersects) continue;
            if (overlayRect.left > rect.left + rect.width / 2) {
              nonLeftOverlayOpen = true;
              break;
            }
            visibleLeft = Math.max(visibleLeft, Math.min(rect.right, Math.ceil(overlayRect.right + 8)));
          }
        }
        const visibleWidth = rect ? rect.right - visibleLeft : 0;
        if (hostOverlayOpen) return;
        void toonFactoryLayout(!rect || nonLeftOverlayOpen || visibleWidth < 240 ? null : {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          clipLeft: Math.max(0, visibleLeft - rect.left),
          borderRadius: sidebarOpen ? 0 : 17,
        })
          .catch((error) => { if (active) setError(errorMessage(error)); });
      });
    };
    const resize = new ResizeObserver(update); resize.observe(container.current);
    const overlays = new MutationObserver(update);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-session-list-preview"],
    });
    window.addEventListener("resize", update); update();
    return () => { active = false; resize.disconnect(); overlays.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, [hostOverlayOpen, ready, sidebarOpen]);
  return (
    <div className="absolute inset-0 flex min-h-0 overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle} data-testid="toon-factory-surface">
      <AppNavigationRail {...props} />
      <AppSecondarySidebarTopControls sidebarOpen={sidebarOpen} onOpenTaskSearch={props.onOpenTaskSearch ?? (() => undefined)} onToggleSidebar={toggleSidebar} />
      <AppInsetSurface testId="toon-factory-inset-surface">
        <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-background">
          <div className={cn("h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear", sidebarOpen ? "w-[var(--jugglework-left-sidebar-width)]" : "w-0")} data-app-secondary-sidebar-frame>
            {sidebarOpen ? <ToonFactoryProjectSidebar {...sidebarRegistration} /> : null}
          </div>
          {sidebarOpen ? <AppSecondarySidebarResizeHandle resizing={leftSidebarResizing} onPointerDown={startLeftSidebarResize} /> : null}
          <main ref={container} className={cn(
            "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-background",
            sidebarOpen ? "rounded-r-[17px]" : "rounded-[17px]",
          )} data-testid="toon-factory-container">
            {hostOverlaySnapshot ? (
              <img
                src={hostOverlaySnapshot}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full object-fill"
                data-toon-factory-overlay-snapshot
              />
            ) : null}
            {error ? <div role="alert" className="max-w-lg space-y-4 p-8 text-center text-sm">
              <p>{error}</p>
              <button type="button" className="rounded-lg border px-4 py-2" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button>
            </div> : !ready ? <div role="status" className="text-sm text-muted-foreground">{t("navigation.toon_factory_starting")}</div> : null}
          </main>
        </div>
      </AppInsetSurface>
      <ToonFactoryProjectDialog open={projectDialogOpen} busy={projectBusy} reauthorizeDirectory={reauthorizeDirectory} onOpenChange={open => {
        setProjectDialogOpen(open);
        if (!open) setReauthorizeDirectory(null);
      }} onChooseFolder={() => { void chooseProjectFolder(); }} />
    </div>
  );
}
