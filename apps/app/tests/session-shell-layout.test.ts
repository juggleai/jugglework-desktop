import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { compile } from "tailwindcss";

const sessionPage = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
const appSidebar = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");
const listPanelHeader = readFileSync(new URL("../src/react-app/shell/list-panel-header.tsx", import.meta.url), "utf8");
const listPanelHeaderCss = readFileSync(new URL("../src/react-app/shell/list-panel-header.css", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../src/app/index.css", import.meta.url), "utf8");
const sessionSurface = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url), "utf8");
const messageList = readFileSync(new URL("../src/components/chat/message-list.tsx", import.meta.url), "utf8");
const quickNavigation = readFileSync(new URL("../src/react-app/domains/session/surface/session-quick-navigation.tsx", import.meta.url), "utf8");

const controlTag = (marker: string) => {
  expect(sessionPage).toContain(marker);
  return sessionPage.slice(0, sessionPage.indexOf(marker)).split("<").at(-1)!;
};
const controlClasses = (marker: string) => controlTag(marker).match(/className="([^"]+)"/)![1];
const platformVariants = appStyles.slice(appStyles.indexOf("@custom-variant windows"), appStyles.indexOf("@custom-variant linux"));
const compilePlatformClasses = async (candidates: string[]) => {
  const noDragUtility = appStyles.match(/@utility titlebar-no-drag\s*\{[^}]+\}/)![0];
  const compiler = await compile(`@theme { --spacing: 4px; --breakpoint-md: 48rem; } ${platformVariants} ${noDragUtility} @tailwind utilities;`);
  return compiler.build(candidates);
};

describe("desktop session shell layout", () => {
  test("uses distinct expand and collapse icons for the todo progress panel", () => {
    const todoPanel = sessionSurface.slice(sessionSurface.indexOf("function TodoPanel"), sessionSurface.indexOf("function SessionSurface"));
    expect(sessionSurface).toContain("Maximize2, Minimize2");
    expect(todoPanel).toContain('const toggleLabel = expanded ? t("sidebar.collapse") : t("sidebar.expand")');
    expect(todoPanel).toMatch(/expanded[\s\S]+<Minimize2[\s\S]+:[\s\S]+<Maximize2/);
    expect(todoPanel).not.toContain("rotate-180");
  });

  test("aligns the desktop transcript text width with the composer", () => {
    expect(sessionSurface).toContain('className="mx-auto w-full max-w-[720px] lg:max-w-[864px]"');
    expect(composer).toContain('className="max-w-[800px] mx-auto"');
    expect(messageList).toContain('"mx-auto max-w-5xl px-3 md:px-8"');
  });

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
    expect(sessionPage).toMatch(/style=\{\{ WebkitAppRegion: "drag" \} as CSSProperties\}[\s\S]+data-session-shell-topbar/);
    expect(sessionPage).toMatch(/data-session-topbar-actions[\s\S]*$/);
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
    expect(appSidebar).toContain('data-session-list-title-search');
    expect(sessionPage).toContain('data-session-sidebar-toggle');
    expect(sessionPage).toContain('absolute left-[calc(var(--sidebar-width)-2rem)] top-1.5');
    expect(sessionPage).toContain('items-center gap-0');
    expect(sessionPage).toContain('shellConfig.sidebar && sidebarOpen');
    expect(sessionPage).toContain('data-session-collapsed-sidebar-controls');
    expect(sessionPage).not.toContain('data-session-collapsed-task-search');
    expect(sessionPage).not.toContain('data-embedded-session-task-search');
    expect(sessionPage).toContain('data-session-collapsed-sidebar-toggle');
    expect(sessionPage).toContain('data-session-collapsed-drag-region');
    expect(sessionPage).toContain('absolute left-0 top-0 h-[var(--session-shell-top-inset)] w-[76px] mac:titlebar-drag');
    expect(sessionPage).toContain('data-session-expanded-drag-region');
    expect(sessionPage).toContain('left-12 top-0 z-20 hidden h-[var(--session-shell-top-inset)] w-[calc(var(--sidebar-width)-7rem)]');
    expect(sessionPage).toContain('WebkitAppRegion: "drag"');
    expect(sessionPage).toContain('shellConfig.sidebar && !sidebarOpen && "mac:pl-[76px] windows:pl-[76px]"');
    expect(sessionPage).toContain('pointer-events-auto');
    expect(sessionPage).toContain('WebkitAppRegion: "no-drag"');
    expect(appSidebar).toContain('onClick={props.onOpenTaskSearch}');
    expect(sessionPage).not.toContain('data-session-task-search');
    expect(sessionPage).not.toContain('!sidebarOpen ? <span className="hidden size-8 shrink-0 mac:block"');
    expect(appSidebar).not.toContain('titleEnd={<SidebarTrigger');
  });

  test("reveals one Windows desktop toggle outside the Rail and keeps its no-drag hit target", async () => {
    const expanded = controlClasses("data-session-sidebar-controls");
    const collapsed = controlClasses("data-session-collapsed-sidebar-controls");
    const dragRegion = controlClasses("data-session-expanded-drag-region");
    for (const marker of ["data-session-sidebar-controls", "data-session-collapsed-sidebar-controls", "data-session-sidebar-toggle", "data-session-collapsed-sidebar-toggle"]) {
      expect(controlTag(marker)).toContain('WebkitAppRegion: "no-drag"');
    }
    for (const classes of [expanded, collapsed]) {
      expect(classes.split(" ")).toContain("hidden");
      expect(classes.split(" ")).toContain("windows:md:flex");
      expect(classes.split(" ")).not.toContain("windows:flex");
    }
    expect(expanded).toContain("left-[calc(var(--sidebar-width)-2rem)] top-1.5");
    expect(dragRegion.split(" ")).toContain("hidden");
    expect(dragRegion.split(" ")).toContain("windows:md:block");
    // Preserve the latest dev drag span and its extra gap before the toggle.
    expect(dragRegion).toContain("left-12");
    expect(dragRegion).toContain("w-[calc(var(--sidebar-width)-7rem)]");
    expect(sessionPage).toContain('<SidebarTrigger className="mac:hidden windows:md:hidden windows:titlebar-no-drag" />');
    expect(sessionPage).toContain('!props.embedded && shellConfig.sidebar && !sidebarOpen && "mac:pl-[76px] windows:pl-[76px]"');
    const secondaryControls = readFileSync(new URL("../src/react-app/shell/app-secondary-sidebar-top-controls.tsx", import.meta.url), "utf8");
    expect(secondaryControls).toContain("COLLAPSED_CONTROL_LEFT = 76");

    const css = await compilePlatformClasses(["windows:md:flex", "windows:md:block", "windows:md:hidden", "windows:pl-[76px]", "windows:titlebar-no-drag"]);
    for (const display of ["flex", "block", "hidden"]) {
      const rule = css.slice(css.indexOf(`.windows\\:md\\:${display} {`)).split("\n.")[0];
      expect(rule).toContain("html.jugglework-electron.jugglework-platform-windows &");
      expect(rule).toContain("@media (width >= 48rem)");
      expect(rule).toContain(`display: ${display === "hidden" ? "none" : display};`);
    }
    expect(css).toContain("padding-left: 76px;");
    expect(css).toMatch(/\.windows\\:titlebar-no-drag\s*\{\s*html\.jugglework-electron\.jugglework-platform-windows &\s*\{\s*app-region: no-drag;/);
  });

  test("limits compact toolbar rules to Windows Sheet widths and restores desktop controls at 768px", async () => {
    const title = controlClasses("data-session-topbar-title");
    const actions = controlClasses("data-session-topbar-actions");
    expect(title.split(" ")).toContain("gap-3");
    expect(title.split(" ")).toContain("windows:max-md:gap-1");
    expect(title.split(" ")).toContain("windows:max-md:min-w-9");
    expect(actions.split(" ")).toContain("gap-1.5");
    expect(actions.split(" ")).toContain("windows:max-md:gap-0");
    expect(sessionPage).toContain('!props.embedded && shellConfig.sidebar && "windows:max-md:pl-[76px]"');
    expect(sessionPage).toContain('inline-flex size-2.5 shrink-0 rounded-full windows:max-md:hidden');
    expect(sessionPage).toContain('sm:block windows:max-md:hidden" aria-hidden="true"');
    expect(sessionPage).toContain('className="windows:max-md:size-8 windows:max-md:px-0 mac:titlebar-no-drag"');
    expect(sessionPage).toContain('<span className="windows:max-md:hidden">{t("den.signin_button")}</span>');
    expect(sessionPage).toContain('aria-label={t("den.signin_title")}');
    const mobileHook = readFileSync(new URL("../src/hooks/use-mobile.ts", import.meta.url), "utf8");
    expect(mobileHook).toContain("MOBILE_BREAKPOINT = 768");

    const candidates = [...new Set(sessionPage.match(/windows:max-md:[\w-]+(?:\[[^\]]+\])?/g))];
    const css = await compilePlatformClasses(candidates);
    const declarations: Record<string, string> = {
      hidden: "display: none;",
      "gap-0": "gap: calc(var(--spacing) * 0);",
      "gap-1": "gap: calc(var(--spacing) * 1);",
      "min-w-9": "min-width: calc(var(--spacing) * 9);",
      "size-8": "width: calc(var(--spacing) * 8);",
      "px-0": "padding-inline: calc(var(--spacing) * 0);",
      "pl-[76px]": "padding-left: 76px;",
    };
    for (const candidate of candidates) {
      const selector = candidate.replace(/[:\[\]]/g, "\\$&");
      expect(css).toContain(`.${selector} {`);
      const rule = css.slice(css.indexOf(`.${selector} {`)).split("\n.")[0];
      expect(rule).toContain("html.jugglework-electron.jugglework-platform-windows &");
      expect(rule).toContain("@media (width < 48rem)");
      expect(rule).toContain(declarations[candidate.slice("windows:max-md:".length)]!);
    }
  });

  test("fits Voice and optional sign-in alongside native Windows caption buttons", () => {
    const title = controlClasses("data-session-topbar-title");
    const actions = controlClasses("data-session-topbar-actions");
    const header = sessionPage.slice(sessionPage.indexOf("const sessionTopBar"), sessionPage.indexOf("data-session-shell-topbar"));
    const button = readFileSync(new URL("../src/components/ui/button.tsx", import.meta.url), "utf8");
    const spacing = 4;
    const buttonWidth = Number(button.match(/"icon-sm": "size-(\d+)"/)![1]) * spacing;
    const titleMinimum = Number(title.match(/windows:max-md:min-w-(\d+)/)![1]) * spacing;
    const titleGap = Number(title.match(/windows:max-md:gap-(\d+)/)![1]) * spacing;
    const actionGap = Number(actions.match(/windows:max-md:gap-(\d+)/)![1]) * spacing;
    const leftInset = Number(header.match(/windows:max-md:pl-\[(\d+)px\]/)![1]);
    const rightPadding = Number(actions.match(/windows:mr-\[(\d+)px\]/)![1]);
    const toolbar = sessionPage.slice(sessionPage.indexOf("data-session-topbar-actions"), sessionPage.indexOf("</header>"));
    expect(toolbar.match(/size="icon-sm"/g)).toHaveLength(6);
    expect(header).toContain("px-4 md:px-6");
    expect(header).toContain("windows:pr-0");
    expect(rightPadding).toBe(138);
    expect(titleMinimum).toBeGreaterThanOrEqual(buttonWidth + titleGap);
    expect(leftInset).toBe(76);

    for (const width of [480, 640, 767]) {
      for (const sidebarOpen of [false, true]) {
        for (const signIn of [false, true]) {
          // Below md the same flow toggle serves both persisted desktop states.
          const count = 6 + Number(signIn);
          const actionsWidth = count * buttonWidth + (count - 1) * actionGap;
          const actionsStart = width - rightPadding - actionsWidth;
          const context = JSON.stringify({ width, sidebarOpen, signIn });
          expect(leftInset + titleMinimum, context).toBeLessThanOrEqual(actionsStart);
          expect(leftInset + buttonWidth + titleGap, context).toBeLessThanOrEqual(actionsStart);
          expect(actionsStart + actionsWidth, context).toBe(width - rightPadding);
        }
      }
    }
    // Reserve the native caption buttons instead of the former 16px padding.
    expect(leftInset + titleMinimum + 7 * buttonWidth + 6 * actionGap + rightPadding).toBe(474);
  });

  test("uses a full-height content divider and an inset top-chrome divider", () => {
    expect(appSidebar).not.toContain('insetDivider');
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

  test("uses a title-only workspace header with search on the right", () => {
    expect(appSidebar).toContain("titleOnly");
    expect(appSidebar).toContain('data-session-list-title-search');
    expect(appSidebar).not.toContain('searchValue={sessionQuery}');
    expect(appSidebar).not.toContain('addControl={(');
    expect(listPanelHeader).toContain('props.titleOnly ? " is-title-only" : ""');
    expect(listPanelHeader).toContain('{!props.titleOnly ? (');
    expect(listPanelHeaderCss).toContain('.jw-list-panel-header.is-title-only');
    expect(listPanelHeaderCss).toContain('height: 48px');
    expect(listPanelHeaderCss).toContain('border-bottom: 0');
  });

  test("previews the collapsed session list from the Rail hover target", () => {
    const sidebarPrimitive = readFileSync(new URL("../src/components/ui/sidebar.tsx", import.meta.url), "utf8");
    expect(sessionPage).toContain('data-session-rail-preview-trigger');
    expect(sessionPage).toContain('<AppNavigationRail');
    expect(sessionPage).toContain('absolute inset-y-0 left-0 z-40 w-12 overflow-hidden');
    expect(sessionPage).toContain('sidebarRailPreviewOpen');
    expect(sessionPage).toContain('handleSidebarPreviewMenuChange');
    expect(sessionPage).toContain('previewTaskScope={sidebarRailPreviewOpen ? sidebarPreviewScope ?? undefined : undefined}');
    expect(sessionPage).toContain('suppressPreviewMenuTooltips');
    expect(sessionPage).toContain('setTimeout(() =>');
    expect(sessionPage).toContain('}, 120)');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef');
    expect(sessionPage).toContain('if (sidebarPreviewPointerInsideRef.current)');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef.current = true');
    expect(sessionPage).toContain('sidebarPreviewPointerInsideRef.current = false');
    expect(sessionPage).toContain('sidebarPreviewMotionDisabled');
    expect(sessionPage).toContain('keepSidebarPreviewMotionDisabledThroughPaint');
    expect(sessionPage).toContain('railPreviewMotionDisabled={sidebarPreviewMotionDisabled}');
    expect(appSidebar).toContain('data-session-list-preview={props.railPreviewActive ? "true" : undefined}');
    expect(appSidebar).toContain('props.railPreviewMotionDisabled && "!transition-none"');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-none"');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-auto"');
    expect(appSidebar).toContain('data-session-preview-title-hover-guard');
    expect(appSidebar).toContain('left-[53px] right-12 top-[45px] z-10 h-10');
    expect(appSidebar).toMatch(/data-session-preview-title-hover-guard[\s\S]*?<ListPanelHeader[\s\S]*?data-session-list-title-search/);
    expect(appSidebar).toContain('props.railPreviewActive ? <div className="w-12 shrink-0"');
    expect(appSidebar).toContain('onMouseEnter={props.onRailPreviewEnter}');
    expect(appSidebar).toContain('onMouseLeave={props.onRailPreviewLeave}');
    expect(appSidebar).toContain('md:rounded-r-[18px]');
    expect(appSidebar).toContain('props.railPreviewActive && "pointer-events-none"');
    expect(appSidebar).not.toContain('w-[348px]!');
    expect(sessionPage).toContain("useLayoutEffect(() => {");
    expect(sessionPage).toContain("if (!appSidebarPreview.target) return;");
    expect(sessionPage).toContain("appSidebarPreview.closePreview();");
    expect(sessionPage).toContain("if (!appSidebarPreview.workspaceTarget) return;");
    expect(sessionPage).toContain("setSidebarPreviewScope(appSidebarPreview.workspaceTarget);");
    expect(sessionPage).toContain("appSidebarPreview.onPreviewEnter();");
    expect(sessionPage).toContain("appSidebarPreview.onPreviewLeave();");
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
    expect(sessionPage).toContain('windows:mr-[138px]');
    expect(sessionPage).toContain('windows:pr-0');
  });

  test("removes the permanent right rail and constrains expanded Files to the rounded surface", () => {
    expect(sessionPage).not.toContain('flex w-11 shrink-0 flex-col items-center');
    expect(sessionPage).not.toContain('right-11');
    expect(sessionPage).toContain('data-files-fullscreen-surface');
    expect(sessionPage).toContain('{ left: "var(--sidebar-width)" }');
    expect(sessionPage).toContain('absolute bottom-1.5 right-1.5 top-11');
    expect(sessionPage).toContain('rounded-[18px] border border-dls-border');
    expect(sessionPage).toContain('left: `${APP_NAVIGATION_RAIL_WIDTH + 4}px`');
    expect(sessionPage).not.toContain('absolute bottom-0 right-0 top-0 z-40');
  });
});
