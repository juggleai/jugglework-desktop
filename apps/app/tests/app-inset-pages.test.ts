import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { compile } from "tailwindcss";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("secondary app inset shells", () => {
  test("defines one shared rounded inset surface contract", () => {
    const source = read("react-app/shell/app-inset-surface.tsx");
    expect(source).toContain("mt-11");
    expect(source).toContain("mb-1.5 ml-1 mr-1.5");
    expect(source).toContain("rounded-[18px]");
    expect(source).toContain("border border-dls-border bg-background");
    expect(source).toContain("data-app-inset-surface");
  });

  test("places Automation, Review, Chat, Contacts, and Toon Factory inside the shared surface", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const reviews = read("react-app/domains/reviews/review-page.tsx");
    const chat = read("react-app/shell/chat-page.tsx");
    const toonFactory = read("react-app/shell/toonFactoryPage.tsx");
    for (const source of [automation, reviews, chat]) {
      expect(source).toContain("bg-dls-sidebar mac:titlebar-drag");
      expect(source).toContain("<AppInsetSurface");
    }
    expect(automation).toContain('testId="automation-inset-surface"');
    expect(reviews).toContain('testId="review-inset-surface"');
    expect(chat).toContain('testId="chat-inset-surface"');
    expect(chat).toContain("<JuggleChatApp");
    expect(toonFactory).toContain("<AppInsetSurface");
    expect(toonFactory).toContain('testId="toon-factory-inset-surface"');
    expect(toonFactory).toContain('sidebarOpen ? "rounded-r-[17px]" : "rounded-[17px]"');
    expect(toonFactory).toContain("borderRadius: sidebarOpen ? 0 : 17");
    expect(toonFactory).toContain("<ToonFactoryProjectSidebar");
    expect(toonFactory).toContain("<ToonFactoryProjectDialog");
    expect(toonFactory).toContain("<AppSecondarySidebarTopControls");
    expect(toonFactory).toContain("<AppSecondarySidebarResizeHandle");
    expect(toonFactory).toContain("usePublishToonFactorySidebar");
    expect(toonFactory).toContain("useAppNavigationSidebarPreview");
    expect(toonFactory).toContain("toonFactorySnapshot");
    expect(toonFactory).toContain("toonFactoryEnter");
    expect(toonFactory).toContain("toonFactoryChooseProject");
    expect(toonFactory).not.toContain("pickDirectory");
    expect(toonFactory).not.toContain('toast.success(result.mode === "imported" ? "已导入漫剧项目" : "已新建漫剧项目");\n      return true;');
    expect(toonFactory).toContain("data-toon-factory-overlay-snapshot");
    expect(toonFactory).toContain("hostOverlayOpen = navigationPreviewOpen || blockingOverlayOpen");
    expect(toonFactory).toContain("[data-jugglework-toast]");
    expect(toonFactory).toContain('[role="menu"]');
    expect(toonFactory).toContain("if (hostOverlayOpen) return");
    expect(toonFactory).toContain("visibleWidth < 240 ? null");
    expect(toonFactory).toContain("visibleLeft = Math.max");
    expect(toonFactory).toContain("clipLeft: Math.max(0, visibleLeft - rect.left)");
    expect(toonFactory).toContain("[data-session-list-preview=\"true\"]");
    expect(toonFactory).toContain("[data-app-rail-tooltip]");
    expect(toonFactory).toContain('attributeFilter: ["class", "style", "data-session-list-preview"]');
    const toonFactorySidebar = read("react-app/shell/toon-factory-sidebar.tsx");
    expect(toonFactorySidebar).toContain(">漫剧工厂</h1>");
    expect(toonFactorySidebar).toContain('<Plus className="size-4" />新建项目');
    expect(toonFactorySidebar).toContain('className="mx-4 shrink-0 border-t border-dls-border"');
    expect(toonFactorySidebar).not.toContain(">项目列表</div>");
    expect(toonFactorySidebar).toContain("group/project relative flex h-10 w-full items-center");
    expect(toonFactorySidebar).toContain("group-hover/project:opacity-100");
    expect(toonFactorySidebar).toContain("data-popup-open:opacity-100");
    expect(toonFactorySidebar).toContain("编辑名称");
    expect(toonFactorySidebar).toContain("在 Finder 中显示");
    expect(toonFactorySidebar).toContain("移除项目");
    expect(toonFactorySidebar).toContain("不会删除文件夹或其中的任何文件");
    expect(toonFactorySidebar).toContain("project.directory.split(/[\\\\/]/).filter(Boolean).at(-1) || project.name");
    expect(toonFactorySidebar).not.toContain("title={project.directory}");
  });

  test("shares the workspace sidebar width across primary app surfaces", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const reviews = read("react-app/domains/reviews/review-page.tsx");
    const apps = read("react-app/shell/apps-page.tsx");
    const pluginSidebar = read("react-app/domains/settings/shell/customization-catalog-sidebar.tsx");

    for (const source of [automation, reviews, apps]) {
      expect(source).toContain("useWorkspaceShellLayout({ expandedRightWidth: 520 })");
      expect(source).toContain('"--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth)');
      expect(source).toContain("<AppSecondarySidebarResizeHandle");
      expect(source).toContain("startLeftSidebarResize");
      expect(source).toContain("<AppSecondarySidebarTopControls");
    }
    expect(automation).toContain("w-[var(--jugglework-left-sidebar-width)]");
    const toonFactory = read("react-app/shell/toonFactoryPage.tsx");
    expect(toonFactory).toContain("useWorkspaceShellLayout({ expandedRightWidth: 520 })");
    expect(toonFactory).toContain('"--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth)');
    expect(toonFactory).toContain("w-[var(--jugglework-left-sidebar-width)]");
    expect(reviews).toContain("md:w-[var(--jugglework-left-sidebar-width)]");
    expect(pluginSidebar).toContain("w-full");

    const resizeHandle = read("react-app/shell/app-secondary-sidebar-resize-handle.tsx");
    expect(resizeHandle).toContain('left: "var(--jugglework-left-sidebar-width)"');
    expect(resizeHandle).toContain('cursor: "col-resize"');
    expect(resizeHandle).toContain("data-app-secondary-sidebar-resize-handle");

    const layout = read("react-app/shell/workspace-shell-layout.ts");
    expect(layout).toContain("workspaceSidebarWidth - APP_INSET_SIDEBAR_OFFSET");
    expect(layout).toContain("calc(100vw - 320px)");

    const topControls = read("react-app/shell/app-secondary-sidebar-top-controls.tsx");
    expect(topControls).toContain("data-app-secondary-sidebar-search");
    expect(topControls).toContain("data-app-secondary-sidebar-toggle");
    expect(topControls).toContain("data-app-secondary-sidebar-top-divider");
    expect(topControls).toContain('className="pointer-events-auto absolute top-1.5 z-50 flex');
    expect(topControls).toContain("COLLAPSED_CONTROL_LEFT = 76");
    expect(topControls).toContain("props.sidebarOpen ? <span");
    expect(topControls).toContain("rtl:rotate-180");

    const settingsRoute = read("react-app/shell/settings-route.tsx");
    for (const source of [automation, reviews, settingsRoute]) {
      expect(source).toContain("transition-[width] duration-200 ease-linear");
      expect(source).toContain("data-app-secondary-sidebar-frame");
    }
  });

  test("uses the Automation sidebar background for local and cloud workspace menus", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const workspaceSidebar = read("react-app/domains/session/sidebar/app-sidebar.tsx");
    const appStyles = read("app/index.css");

    expect(appStyles.match(/--app-secondary-sidebar-bg:/g)).toHaveLength(2);
    expect(appStyles).toContain("color-mix(in srgb, var(--app-list-bg) 45%, var(--app-page-bg))");
    expect(automation).toContain("bg-[var(--app-secondary-sidebar-bg)]");
    const pluginSidebar = read("react-app/domains/settings/shell/customization-catalog-sidebar.tsx");
    expect(pluginSidebar).toContain("bg-[var(--app-secondary-sidebar-bg)]");
    expect(pluginSidebar).not.toContain("bg-dls-sidebar/55");
    expect(workspaceSidebar).toContain("flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-secondary-sidebar-bg)]");
    expect(workspaceSidebar).toContain("data-session-list-surface");
  });

  test("reveals collapsed Automation, Plugins, and Toon Factory sidebars as Rail hover flyouts", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const apps = read("react-app/shell/apps-page.tsx");
    const settingsRoute = read("react-app/shell/settings-route.tsx");
    const previewHost = read("react-app/shell/app-navigation-sidebar-preview.tsx");
    const workspaceRoute = read("react-app/shell/workspace-app-route.tsx");
    const automationPreview = read("react-app/domains/automations/automation-sidebar-preview.tsx");

    expect(workspaceRoute).toContain("<AppNavigationSidebarPreviewProvider>");
    expect(previewHost).toContain('AppNavigationSidebarPreviewTarget = "automation" | "plugins" | "toon-factory"');
    expect(previewHost).toContain("data-app-navigation-sidebar-preview={props.target}");
    expect(previewHost).toContain("left-[52px] top-11");
    expect(previewHost).toContain("rounded-[18px]");
    expect(previewHost).toContain("shadow-[0_18px_48px_rgba(15,23,42,0.18)]");
    expect(previewHost).toContain("const CLOSE_DELAY = 120");
    expect(previewHost).toContain("pointerInsideRef.current");
    expect(previewHost).toContain("<AutomationSidebarPreview />");
    expect(previewHost).toContain("<ToonFactoryProjectSidebar preview");
    expect(previewHost).toContain("<CustomizationCatalogSidebar");
    expect(previewHost).toContain("usePublishToonFactorySidebar");
    expect(automationPreview).toContain('data-testid="automation-sidebar-preview"');
    expect(automationPreview).toContain("rounded-[18px] border border-dls-border");
    expect(settingsRoute).toContain("usePublishAppNavigationPluginItems");
    const pluginSidebar = read("react-app/domains/settings/shell/customization-catalog-sidebar.tsx");
    expect(pluginSidebar).toContain('props.preview ? "rounded-[18px] border border-dls-border" : "border-r border-dls-border"');
    expect(previewHost).toContain("preview");
    expect(automation).not.toContain("useAppSecondarySidebarHoverPreview");
    expect(apps).not.toContain("useAppSecondarySidebarHoverPreview");
  });

  test("reveals only the retained workspace list above dedicated app surfaces", () => {
    const workspaceRoute = read("react-app/shell/workspace-app-route.tsx");
    const previewHost = read("react-app/shell/app-navigation-sidebar-preview.tsx");
    const wrapper = workspaceRoute.slice(workspaceRoute.indexOf("className={settingsVisible ||"), workspaceRoute.indexOf('data-testid="retained-session-surface"'));
    expect(workspaceRoute).toContain("navigationPreview.workspaceTarget");
    expect(wrapper).toContain("settingsVisible || chatVisible || appsVisible || automationsVisible || reviewsVisible || toonFactoryVisible");
    expect(wrapper).toContain('"invisible absolute inset-0 z-50');
    expect(wrapper).toContain("[&_[data-session-list-preview=true]]:visible");
    expect(wrapper).toContain("[&_[data-session-list-preview=true]]:pointer-events-auto");
    expect(wrapper).toContain("[&_[data-session-preview-title-hover-guard]]:visible");
    expect(wrapper).toContain(': "hidden"');
    expect(wrapper).toContain(': "h-full min-h-0"');
    expect(wrapper).not.toContain("opacity-0");
    expect(workspaceRoute).toContain("surfaceVisible={automationSessionVisible || !(settingsVisible || chatVisible || appsVisible || automationsVisible || reviewsVisible || toonFactoryVisible)}");
    expect(previewHost).toContain("workspaceTarget: TaskScope | null");
    expect(previewHost).toContain("onWorkspaceTriggerChange");
  });

  test("generates inherited invisibility with visibility overrides only for the list and hover guard", async () => {
    const workspaceRoute = read("react-app/shell/workspace-app-route.tsx");
    const previewClasses = workspaceRoute.match(/\? "(invisible absolute inset-0 z-50[^"\n]+)"/)?.[1];
    expect(previewClasses).toBeDefined();
    const compiler = await compile("@tailwind utilities;");
    const css = compiler.build(previewClasses!.split(" "));
    expect(css).toContain(".invisible {\n  visibility: hidden;");
    expect(css).toContain("& [data-session-list-preview=true] {\n    visibility: visible;");
    expect(css).toContain("& [data-session-list-preview=true] {\n    pointer-events: auto;");
    expect(css).toContain("& [data-session-preview-title-hover-guard] {\n    visibility: visible;");
    expect(css.match(/visibility: visible;/g)).toHaveLength(2);
  });

  test("joins the Settings navigation and content into one rounded surface", () => {
    const page = read("react-app/domains/settings/shell/settings-page.tsx");
    const shell = read("react-app/domains/settings/shell/settings-shell.tsx");
    expect(page).toContain("data-settings-list-surface");
    expect(page).toContain("mt-11");
    expect(page).toContain("rounded-l-[18px]");
    expect(page).toContain("border-r-0");
    expect(shell).toContain("data-settings-content-surface");
    expect(shell).toContain("mt-11");
    expect(shell).toContain("rounded-r-[18px]");
    expect(shell).toContain("border border-dls-border");
    expect(shell).not.toContain("border-l-0");
  });
});
