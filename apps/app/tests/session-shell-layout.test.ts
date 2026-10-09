import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const sessionPage = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
const appSidebar = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");
const listPanelHeader = readFileSync(new URL("../src/react-app/shell/list-panel-header.tsx", import.meta.url), "utf8");
const listPanelHeaderCss = readFileSync(new URL("../src/react-app/shell/list-panel-header.css", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../src/app/index.css", import.meta.url), "utf8");
const sessionSurface = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");
const quickNavigation = readFileSync(new URL("../src/react-app/domains/session/surface/session-quick-navigation.tsx", import.meta.url), "utf8");

describe("desktop session shell layout", () => {
  test("uses one tinted chrome around an inset rounded work surface", () => {
    expect(sessionPage).toContain('data-session-shell-chrome');
    expect(sessionPage).toContain('data-session-shell-topbar');
    expect(sessionPage).toContain('bg-dls-sidebar');
    expect(sessionPage).toContain('data-session-work-surface');
    expect(sessionPage).toContain('rounded-[18px]');
    expect(sessionPage).toContain('bg-background');
    expect(sessionPage).toContain('overflow-hidden');
    expect(appStyles).toContain('--app-list-bg: #f7f7f8');
    expect(appStyles).toContain('[data-theme="dark"]');
    expect(appStyles).toContain('--app-list-bg: var(--slate-2)');
  });

  test("extends the rounded session surface around the conversation list", () => {
    expect(appSidebar).toContain('data-session-list-surface');
    expect(sessionPage).toContain('"--session-shell-top-inset": "44px"');
    expect(sessionPage).toContain('h-[var(--session-shell-top-inset)]');
    expect(appSidebar).toContain('md:mt-[var(--session-shell-top-inset)]');
    expect(appSidebar).toContain('md:ml-1');
    expect(appSidebar).toContain('md:-mr-px');
    expect(appSidebar).toContain('md:rounded-l-[18px]');
    expect(appSidebar).toContain('md:border-r-0');
    expect(appSidebar).toContain('bg-background');
    expect(sessionPage).toContain('ml-[52px] rounded-[18px]');
    expect(sessionPage).toContain('rounded-[18px]');
    expect(sessionPage).toContain('md:rounded-l-none md:rounded-r-[18px] md:border-l-0');
    expect(sessionPage).toContain('shellConfig.sidebar && sidebarOpen');
  });

  test("keeps the sidebar toggle in one stable top-chrome position", () => {
    expect(sessionPage).toContain('data-session-sidebar-controls');
    expect(sessionPage).toContain('data-session-task-search');
    expect(sessionPage).toContain('data-session-sidebar-toggle');
    expect(sessionPage).toContain('absolute left-[calc(var(--sidebar-width)-4rem)] top-1.5');
    expect(sessionPage).toContain('items-center gap-0');
    expect(sessionPage).toContain('shellConfig.sidebar && sidebarOpen');
    expect(sessionPage).toContain('data-session-collapsed-sidebar-controls');
    expect(sessionPage).toContain('data-session-collapsed-task-search');
    expect(sessionPage).toContain('data-session-collapsed-sidebar-toggle');
    expect(sessionPage).toContain('data-session-collapsed-drag-region');
    expect(sessionPage).toContain('absolute left-0 top-0 h-[var(--session-shell-top-inset)] w-[76px] mac:titlebar-drag');
    expect(sessionPage).toContain('data-session-expanded-drag-region');
    expect(sessionPage).toContain('left-12 top-0 z-20 hidden h-[var(--session-shell-top-inset)] w-[calc(var(--sidebar-width)-7rem)]');
    expect(sessionPage).toContain('WebkitAppRegion: "drag"');
    expect(sessionPage).toContain('shellConfig.sidebar && !sidebarOpen && "mac:pl-[76px]"');
    expect(sessionPage).toContain('pointer-events-auto');
    expect(sessionPage).toContain('WebkitAppRegion: "no-drag"');
    expect(sessionPage).toContain('onClick={props.sidebar.onOpenTaskSearch}');
    expect(sessionPage.indexOf('data-session-task-search')).toBeLessThan(sessionPage.indexOf('data-session-sidebar-toggle'));
    expect(sessionPage).not.toContain('!sidebarOpen ? <span className="hidden size-8 shrink-0 mac:block"');
    expect(appSidebar).not.toContain('titleEnd={<SidebarTrigger');
  });

  test("uses a full-height content divider and an inset top-chrome divider", () => {
    expect(appSidebar).toContain('insetDivider');
    expect(appSidebar).toContain('border-e-0!');
    expect(listPanelHeader).toContain('has-inset-divider');
    expect(listPanelHeaderCss).toContain('.jw-list-panel-header.has-inset-divider::after');
    expect(listPanelHeaderCss).toContain('right: 12px');
    expect(listPanelHeaderCss).toContain('left: 12px');
    expect(sessionPage).toContain('data-session-content-divider');
    expect(sessionPage).toContain('absolute -inset-y-px left-0 z-30 hidden w-px bg-dls-border md:block');
    expect(sessionPage).toContain('md:border-l-0');
    expect(sessionPage).not.toContain('md:before:bottom-3');
    expect(sessionPage).not.toContain('md:before:top-3');
    expect(sessionPage).toContain('md:peer-data-[state=expanded]:before:top-2');
    expect(sessionPage).toContain('md:peer-data-[state=expanded]:before:h-7');
  });

  test("keeps the macOS list title close to the rounded surface top", () => {
    const macHeader = listPanelHeaderCss.slice(
      listPanelHeaderCss.indexOf('.jw-list-panel-header.is-mac'),
      listPanelHeaderCss.indexOf('.jw-list-panel-title-row'),
    );
    expect(macHeader).toContain('height: 82px');
    expect(macHeader).toContain('min-height: 82px');
    expect(macHeader).toContain('flex-basis: 82px');
    expect(macHeader).toContain('padding-top: 10px');
  });

  test("previews the collapsed session list from the Rail hover target", () => {
    const sidebarPrimitive = readFileSync(new URL("../src/components/ui/sidebar.tsx", import.meta.url), "utf8");
    expect(sessionPage).toContain('data-session-rail-preview-trigger');
    expect(sessionPage).toContain('<AppNavigationRail');
    expect(sessionPage).toContain('absolute inset-y-0 left-0 z-40 w-12 overflow-hidden');
    expect(sessionPage).toContain('sidebarRailPreviewOpen');
    expect(sessionPage).toContain('handleSidebarPreviewMenuChange');
    expect(sessionPage).toContain('previewTaskScope={sidebarPreviewScope ?? undefined}');
    expect(sessionPage).toContain('suppressPreviewMenuTooltips');
    expect(sessionPage).toContain('setTimeout(() =>');
    expect(sessionPage).toContain('}, 120)');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef');
    expect(sessionPage).toContain('if (sidebarPreviewPointerInsideRef.current)');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef.current = true');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef.current = false');
    expect(appSidebar).toContain('data-session-list-preview={props.railPreviewActive ? "true" : undefined}');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-none"');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-auto"');
    expect(appSidebar).toContain('data-session-preview-title-hover-guard');
    expect(appSidebar).toContain('left-[53px] right-0 top-[45px] z-10 h-10');
    expect(appSidebar).toContain('props.railPreviewActive ? <div className="w-12 shrink-0"');
    expect(appSidebar).toContain('onMouseEnter={props.onRailPreviewEnter}');
    expect(appSidebar).toContain('onMouseLeave={props.onRailPreviewLeave}');
    expect(appSidebar).toContain('md:rounded-r-[18px]');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-none w-[348px]!"');
    expect(appSidebar).toContain('const taskScope = props.previewTaskScope ?? storedTaskScope');
    expect(appSidebar).not.toContain('suppressPreviewMenuTooltips={props.railPreviewActive}');
    expect(sidebarPrimitive).toContain('has-[[data-session-list-preview=true]]:left-0');
    expect(sidebarPrimitive).toContain('has-[[data-session-list-preview=true]]:z-50');
    expect(listPanelHeaderCss).toContain('[data-session-list-preview="true"] .jw-list-panel-header');
    expect(listPanelHeaderCss).toContain('[data-session-list-preview="true"] .jw-list-panel-title-row');
    expect(listPanelHeaderCss).toContain('[data-session-list-preview="true"] .jw-list-panel-title');
    expect(listPanelHeaderCss).toContain('-webkit-app-region: no-drag');
  });

  test("keeps quick navigation outside the Rail when the sidebar is collapsed", () => {
    expect(sessionPage).toContain('quickNavigationLeftOffset={8}');
    expect(sessionSurface).toContain('quickNavigationLeftOffset?: number');
    expect(sessionSurface).toContain('leftOffset={props.quickNavigationLeftOffset}');
    expect(quickNavigation).toContain('leftOffset = 8');
    expect(quickNavigation).toContain('style={{ left: `${leftOffset}px` }}');
  });

  test("places side-panel actions horizontally in the top bar", () => {
    const topbar = sessionPage.slice(sessionPage.indexOf('data-session-topbar-actions'), sessionPage.indexOf('data-session-shell-chrome'));
    expect(topbar).toContain('aria-label="Browser"');
    expect(topbar).toContain('aria-label={t("session_files.entry")}');
    expect(topbar).toContain('aria-label="Extensions"');
    expect(topbar).toContain('aria-label="Voice Mode"');
    expect(topbar).toContain('aria-pressed={panelRailActive}');
    expect(topbar).toContain('aria-pressed={filesRailActive}');
    expect(topbar).toContain('aria-pressed={extensionsRailActive}');
    expect(topbar).toContain('mac:titlebar-no-drag');
    expect(topbar).toContain('isElectronRuntime() && actionSessionId');
    expect(topbar).toContain('isLocalWorkspace && actionSessionId');
    expect(topbar).toContain('props.settingsSlot && actionSessionId ? openExtensionsRailPane : props.onOpenSettings');
  });

  test("removes the permanent right rail and constrains expanded Files to the rounded surface", () => {
    expect(sessionPage).not.toContain('flex w-11 shrink-0 flex-col items-center');
    expect(sessionPage).not.toContain('right-11');
    expect(sessionPage).toContain('data-files-fullscreen-surface');
    expect(sessionPage).toContain('absolute bottom-1.5 right-1.5 top-11');
    expect(sessionPage).toContain('rounded-[18px] border border-dls-border');
    expect(sessionPage).toContain('left: `${APP_NAVIGATION_RAIL_WIDTH + 4}px`');
    expect(sessionPage).not.toContain('absolute bottom-0 right-0 top-0 z-40');
  });
});
