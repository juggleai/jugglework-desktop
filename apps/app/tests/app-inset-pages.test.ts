import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

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

  test("places Automation, Review, Chat, and Contacts inside the shared surface", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const reviews = read("react-app/domains/reviews/review-page.tsx");
    const chat = read("react-app/shell/chat-page.tsx");
    for (const source of [automation, reviews, chat]) {
      expect(source).toContain("bg-dls-sidebar mac:titlebar-drag");
      expect(source).toContain("<AppInsetSurface");
    }
    expect(automation).toContain('testId="automation-inset-surface"');
    expect(reviews).toContain('testId="review-inset-surface"');
    expect(chat).toContain('testId="chat-inset-surface"');
    expect(chat).toContain("<JuggleChatApp");
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
    expect(reviews).toContain("md:w-[var(--jugglework-left-sidebar-width)]");
    expect(pluginSidebar).toContain("w-[var(--jugglework-left-sidebar-width)]");

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
  });

  test("uses the Automation sidebar background for local and cloud workspace menus", () => {
    const automation = read("react-app/domains/automations/automation-page.tsx");
    const workspaceSidebar = read("react-app/domains/session/sidebar/app-sidebar.tsx");
    const appStyles = read("app/index.css");

    expect(appStyles.match(/--app-secondary-sidebar-bg:/g)).toHaveLength(2);
    expect(appStyles).toContain("color-mix(in srgb, var(--app-list-bg) 45%, var(--app-page-bg))");
    expect(automation).toContain("bg-[var(--app-secondary-sidebar-bg)]");
    expect(workspaceSidebar).toContain("flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-secondary-sidebar-bg)]");
    expect(workspaceSidebar).toContain("data-session-list-surface");
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
