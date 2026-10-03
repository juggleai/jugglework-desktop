import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const sessionPage = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
const appSidebar = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");
const listPanelHeader = readFileSync(new URL("../src/react-app/shell/list-panel-header.tsx", import.meta.url), "utf8");
const listPanelHeaderCss = readFileSync(new URL("../src/react-app/shell/list-panel-header.css", import.meta.url), "utf8");

describe("desktop session shell layout", () => {
  test("uses one tinted chrome around an inset rounded work surface", () => {
    expect(sessionPage).toContain('data-session-shell-chrome');
    expect(sessionPage).toContain('data-session-shell-topbar');
    expect(sessionPage).toContain('bg-dls-sidebar');
    expect(sessionPage).toContain('data-session-work-surface');
    expect(sessionPage).toContain('rounded-[18px]');
    expect(sessionPage).toContain('bg-background');
    expect(sessionPage).toContain('overflow-hidden');
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
    expect(sessionPage).toContain('md:rounded-l-none md:rounded-r-[18px]');
    expect(sessionPage).toContain('shellConfig.sidebar && sidebarOpen');
  });

  test("keeps the sidebar toggle in one stable top-chrome position", () => {
    expect(sessionPage).toContain('data-session-sidebar-toggle');
    expect(sessionPage).toContain('absolute left-28 top-1.5');
    expect(sessionPage).toContain('!sidebarOpen ? <span className="hidden size-8 shrink-0 mac:block"');
    expect(appSidebar).not.toContain('titleEnd={<SidebarTrigger');
  });

  test("insets internal dividers away from the rounded surface edges", () => {
    expect(appSidebar).toContain('insetDivider');
    expect(listPanelHeader).toContain('has-inset-divider');
    expect(listPanelHeaderCss).toContain('.jw-list-panel-header.has-inset-divider::after');
    expect(listPanelHeaderCss).toContain('right: 12px');
    expect(listPanelHeaderCss).toContain('left: 12px');
    expect(sessionPage).toContain('md:before:top-3');
    expect(sessionPage).toContain('md:before:bottom-3');
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

  test("removes the permanent right rail and gives expanded Files the full right edge", () => {
    expect(sessionPage).not.toContain('flex w-11 shrink-0 flex-col items-center');
    expect(sessionPage).not.toContain('right-11');
    expect(sessionPage).toContain('absolute bottom-0 right-0 top-0');
  });
});
