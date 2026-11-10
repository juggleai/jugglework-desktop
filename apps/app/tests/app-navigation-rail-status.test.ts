import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { isIMNavigationVisible, visibleLocalWorkspaceIndicator } from "../src/react-app/shell/app-navigation-status";

const railSource = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");

describe("local workspace rail status", () => {
  test("hides running status while the local workspace page is visible", () => {
    expect(visibleLocalWorkspaceIndicator("running", true, "local")).toBeNull();
  });

  test("shows running status after leaving the local workspace page", () => {
    expect(visibleLocalWorkspaceIndicator("running", false, "local")).toBe("running");
    expect(visibleLocalWorkspaceIndicator("running", true, "remote")).toBe("running");
  });

  test("uses the shared dark-mode-safe progress indicator for the rail", () => {
    expect(railSource).toMatch(/statusIndicator === "running"[\s\S]+<SessionCircularProgress \/>/);
  });

  test("only suppresses loading and preserves empty or unread aggregate states", () => {
    expect(visibleLocalWorkspaceIndicator(null, false, "local")).toBeNull();
    expect(visibleLocalWorkspaceIndicator("completed", false, "local")).toBe("completed");
    expect(visibleLocalWorkspaceIndicator("completed", true, "local")).toBe("completed");
  });
});

describe("scheduled-task rail status", () => {
  test("shows global automation activity only after leaving the automation rail", () => {
    const automation = railSource.slice(
      railSource.indexOf('label={t("navigation.automations")}'),
      railSource.indexOf("</RailButton>", railSource.indexOf('label={t("navigation.automations")}')),
    );
    expect(railSource).toContain("const { hasActiveRuns } = useAutomationActivity()");
    expect(automation).toContain('statusIndicator={!automationsActive && hasActiveRuns ? "running" : null}');
  });
});

describe("Code Review navigation", () => {
  test("moves Code Review into the More menu with a persistent pin action", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-reviews"');
    expect(source).toContain('data-testid="app-rail-more"');
    expect(source).toContain('data-testid="app-navigation-more-reviews"');
    expect(source).toContain('data-testid="app-navigation-pin-reviews"');
    expect(source).toContain("setAppNavigationItemPinned(\"reviews\", !reviewsPinned)");
    expect(source).toContain("props.onOpenReviews()");
  });

  test("shares the pinned separator while keeping the Review entry conditional", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const pinnedSection = source.slice(
      source.indexOf("{tasksPinned || calendarPinned || reviewsPinned || toonFactoryPinned ? ("),
      source.indexOf("</nav>"),
    );
    const pinnedBlock = source.slice(source.indexOf("{reviewsPinned ? ("), source.indexOf(") : null}", source.indexOf("{reviewsPinned ? (")));
    expect(pinnedSection).toContain('data-testid="app-navigation-pinned-separator"');
    expect(pinnedSection).toContain("{reviewsPinned ? (");
    expect(pinnedBlock).toContain('testId="app-rail-pinned-reviews"');
    expect(pinnedBlock).toContain("active={props.reviewsActive}");
    expect(pinnedBlock).toContain("onClick={props.onOpenReviews}");
    expect(pinnedSection).toContain('className="h-px w-6 rounded-full bg-dls-secondary/20"');
  });

  test("reveals the pin action on hover unless Review is already pinned", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const menuRow = source.slice(
      source.indexOf('data-testid="app-navigation-more-reviews-row"') - 220,
      source.indexOf('data-testid="app-navigation-pinned-separator"'),
    );
    expect(menuRow).toContain('className="group flex items-center gap-1 rounded-2xl transition-colors hover:bg-accent focus-within:bg-accent"');
    expect(menuRow).toContain('className="min-w-0 flex-1 bg-transparent py-[5px] focus:bg-transparent! data-highlighted:bg-transparent!"');
    expect(menuRow).toContain('reviewsPinned');
    expect(menuRow).toContain('tabIndex={reviewsPinned ? 0 : -1}');
    expect(menuRow).toContain('opacity-100');
    expect(menuRow).toContain('pointer-events-none opacity-0');
    expect(menuRow).toContain('group-hover:pointer-events-auto group-hover:opacity-100');
    expect(menuRow).not.toContain('group-focus-within:pointer-events-auto');
    expect(menuRow).not.toContain('hover:bg-foreground/10');
    expect(source).toContain('className="w-[180px] rounded-2xl bg-popover/95 p-0.5');
  });
});

describe("Calendar navigation", () => {
  const calendarRow = railSource.slice(
    railSource.indexOf('data-testid="app-navigation-more-calendar-row"'),
    railSource.indexOf('data-testid="app-navigation-more-reviews-row"'),
  );
  const pinnedBlock = railSource.slice(
    railSource.indexOf("{calendarPinned ? ("),
    railSource.indexOf(") : null}", railSource.indexOf("{calendarPinned ? (")),
  );

  test("lists Calendar in More between Tasks and Code Review", () => {
    expect(railSource.indexOf('data-testid="app-navigation-more-tasks-row"')).toBeLessThan(railSource.indexOf('data-testid="app-navigation-more-calendar-row"'));
    expect(railSource.indexOf('data-testid="app-navigation-more-calendar-row"')).toBeLessThan(railSource.indexOf('data-testid="app-navigation-more-reviews-row"'));
    expect(calendarRow).toContain("onClick={openCalendar}");
    expect(calendarRow).toContain('data-testid="app-navigation-more-calendar"');
    expect(railSource).toContain('navigate("/calendar")');
  });

  test("marks the active Calendar entry from the parsed global route", () => {
    expect(railSource).toContain('const calendarActive = parseWorkspaceAppPath(location.pathname)?.view === "calendar"');
    expect(calendarRow).toContain('aria-current={calendarActive ? "page" : undefined}');
    expect(pinnedBlock).toContain("active={calendarActive}");
  });

  test("pins and unpins with a keyboard-reachable named toggle", () => {
    expect(calendarRow).toContain('data-testid="app-navigation-pin-calendar"');
    expect(calendarRow).toContain("tabIndex={0}");
    expect(calendarRow).toContain("aria-pressed={calendarPinned}");
    expect(calendarRow).toContain('aria-label={calendarPinned ? t("navigation.unpin_item") : t("navigation.pin_item")}');
    expect(calendarRow).toContain("focus:pointer-events-auto focus:opacity-100");
    expect(railSource).toContain('setAppNavigationItemPinned("calendar", !calendarPinned)');
  });

  test("shows the pinned rail entry only while pinned and keeps it routing to /calendar", () => {
    expect(pinnedBlock).toContain('testId="app-rail-pinned-calendar"');
    expect(pinnedBlock).toContain("onClick={openCalendar}");
  });
});

describe("Toon Factory navigation", () => {
  test("keeps Toon Factory below Code Review in More and supports pinning", () => {
    expect(railSource.indexOf('data-testid="app-navigation-more-reviews-row"')).toBeLessThan(
      railSource.indexOf('data-testid="app-navigation-more-toon-factory-row"'),
    );
    expect(railSource).toContain('data-testid="app-navigation-pin-toon-factory"');
    expect(railSource).toContain('testId="app-rail-pinned-toon-factory"');
    expect(railSource).toContain('appPreviewTarget={toonFactoryActive ? "toon-factory" : undefined}');
    expect(railSource).toContain('setAppNavigationItemPinned("toon-factory", !toonFactoryPinned)');
  });

  test("opens and activates only the current encoded workspace route", () => {
    expect(railSource).toContain("const workspaceId = props.workspaceId.trim()");
    expect(railSource).toContain('appPath?.view === "toon-factory" && appPath.workspaceId === workspaceId');
    expect(railSource).toContain("navigate(workspaceToonFactoryRoute(workspaceId))");
    expect(railSource).not.toContain('navigate("/toon-factory")');
    expect(railSource).toContain("disabled={!workspaceId}");
  });
});

describe("navigation rail visual proportions", () => {
  test("uses a compact rail with larger, consistent icons and quiet selected states", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain("APP_NAVIGATION_RAIL_WIDTH = 48");
    expect(source).toContain('data-app-navigation-rail');
    expect(source).toContain('w-12');
    expect(source).toContain('size-9');
    expect(source).toContain('[&>svg]:size-5');
    expect(source).toContain('rounded-xl');
    expect(source).toContain('active && "bg-dls-active [&>svg]:fill-current"');
    expect(source).not.toContain('active && "border-dls-border bg-background text-dls-text shadow-sm"');
  });

  test("uses a theme-token home icon for the local workspace", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const localWorkspace = source.slice(source.indexOf('testId="app-rail-home"'), source.indexOf('</RailButton>', source.indexOf('testId="app-rail-home"')));
    expect(localWorkspace).toContain('<LocalWorkspaceIcon active={Boolean(props.homeActive && taskScope === "local")} />');
    expect(localWorkspace).not.toContain('<FolderOpen');
  });

  test("keeps a background-colored doorway in the filled home icon", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const icon = source.slice(source.indexOf('function LocalWorkspaceIcon'), source.indexOf('function RailButton'));
    expect(icon).toContain('data-local-workspace-icon="filled"');
    expect(icon).toContain('fill="currentColor"');
    expect(icon).toContain('data-local-workspace-doorway');
    expect(icon).toContain('fill="var(--dls-active)"');
  });

  test("fills the selected Rail icon black in light mode and white in dark mode", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../src/styles/custom.css", import.meta.url), "utf8");
    expect(source).toContain('data-active={active ? "true" : undefined}');
    expect(source).toContain('[&>svg]:fill-current');
    expect(styles).toContain('[data-app-rail-button][data-active="true"]');
    expect(styles).toContain('color: #000');
    expect(styles).toContain('[data-theme="dark"] [data-app-rail-button][data-active="true"]');
    expect(styles).toContain('color: #fff');
  });

  test("keeps the account trigger visually lighter than the primary actions", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const trigger = source.slice(source.indexOf('data-testid="app-rail-account-menu"'), source.indexOf("</button>", source.indexOf('data-testid="app-rail-account-menu"')));
    expect(trigger).toContain('size-9');
    expect(trigger).toContain('className="size-7 bg-background ring-1 ring-dls-border/70"');
  });

  test("shows hover tooltips for every Rail destination", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain('showTooltip?: boolean');
    expect(source).toContain('data-app-rail-tooltip');
    expect(source).toContain('sideOffset={6}');
    expect(source).toContain('hideArrow');
    expect(source).toContain('rounded-xl border border-dls-border bg-dls-active');
    expect(source).toContain('px-2.5 py-1.5 text-xs font-normal text-dls-text');
    expect(source).toContain('{tooltipLabel ?? label}');
    for (const testId of ["app-rail-home", "app-rail-pinned-reviews", "app-rail-automations", "app-rail-chat", "app-rail-contacts"]) {
      const button = source.slice(source.indexOf(`testId="${testId}"`) - 220, source.indexOf(`testId="${testId}"`) + 220);
      expect(button).not.toContain('showTooltip={false}');
    }
    expect(source).toContain('title={t("navigation.more")}');
  });

  test("places More after Contacts and keeps pinned entries below it", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source.indexOf('testId="app-rail-contacts"')).toBeLessThan(source.indexOf('data-testid="app-rail-more"'));
    expect(source.indexOf('data-testid="app-rail-more"')).toBeLessThan(source.indexOf('testId="app-rail-pinned-reviews"'));
  });

  test("moves Tasks into More while preserving active and unread feedback", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-tasks"');
    expect(source).toContain('data-testid="app-navigation-more-tasks"');
    expect(source).toContain('data-testid="app-navigation-pin-tasks"');
    expect(source).toContain('setAppNavigationItemPinned("tasks", !tasksPinned)');
    expect(source).toContain('testId="app-rail-pinned-tasks"');
    expect(source).toContain('onClick={openTasks}');
    expect(source).toContain('navigationMenuOpen || (tasksActive && !tasksPinned)');
    expect(source).toContain('data-task-menu-unread-dot');
    expect(source).toContain('taskUnreadCount > 99 ? "99+" : taskUnreadCount');
  });

  test("keeps only the pinned Tasks destination selected and supports keyboard preview", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain('(tasksActive && !tasksPinned)');
    expect(source).toContain('onFocus={() => {');
    expect(source).toContain('onBlur={() => {');
    expect(source).toContain('onAppPreviewChange?.(appPreviewTarget, true)');
  });

  test("opens the active pinned Tasks sidebar preview without changing the More row", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const pinnedTasks = source.slice(source.indexOf("{tasksPinned ? ("), source.indexOf(") : null}", source.indexOf("{tasksPinned ? (")));
    const moreTasks = source.slice(source.indexOf('data-testid="app-navigation-more-tasks-row"'), source.indexOf('data-testid="app-navigation-pin-tasks"'));
    expect(pinnedTasks).toContain('appPreviewTarget={tasksActive ? "tasks" : undefined}');
    expect(pinnedTasks).toContain('onAppPreviewChange={appSidebarPreview.onTriggerChange}');
    expect(pinnedTasks).toContain('showTooltip={!tasksActive || !appSidebarPreview.enabled}');
    expect(moreTasks).not.toContain("appPreviewTarget");
  });

  test("matches the Tasks menu icon and pin affordance to sibling menu rows", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const rowStart = source.lastIndexOf("<div", source.indexOf('data-testid="app-navigation-more-tasks-row"'));
    const rowEnd = source.indexOf("</div>", source.indexOf('data-testid="app-navigation-more-tasks-row"'));
    const row = source.slice(rowStart, rowEnd);
    expect(row).toContain('[&>svg]:size-5');
    expect(row).toContain('hover:bg-accent focus-within:bg-accent');
    expect(row).not.toContain('tasksActive && "bg-accent');
    expect(row).toContain('group-hover:pointer-events-auto group-hover:opacity-100');
    expect(row).toContain('tabIndex={0}');
    expect(row).toContain('focus:pointer-events-auto focus:opacity-100');
    expect(row).toContain('<Pin className={cn("size-4", tasksPinned && "fill-current")} />');
  });

  test("places Plugins immediately after scheduled tasks and opens the Apps surface", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain('testId="app-rail-plugins"');
    expect(source).toContain('label={t("project_extensions.group_plugin")}');
    expect(source).toContain("active={props.appsActive}");
    expect(source).toContain("onClick={props.onOpenApps}");
    expect(source).toContain("<PluginOrbitIcon />");
    expect(source).not.toContain("<Puzzle />");
    expect(source.indexOf('testId="app-rail-automations"')).toBeLessThan(source.indexOf('testId="app-rail-plugins"'));
    expect(source.indexOf('testId="app-rail-plugins"')).toBeLessThan(source.indexOf('testId="app-rail-chat"'));
  });

  test("shows global category and installed navigation in the Plugins surface", () => {
    const route = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
    const sidebar = readFileSync(new URL("../src/react-app/domains/settings/shell/customization-catalog-sidebar.tsx", import.meta.url), "utf8");
    const catalogBranch = route.slice(
      route.indexOf("if (props.pluginCatalogOnly)"),
      route.indexOf("// TIPS: 仅会话右侧 rail", route.indexOf("if (props.pluginCatalogOnly)")),
    );
    expect(catalogBranch).toContain("<CloudMarketplacesView");
    expect(catalogBranch).toContain("applicationCatalog");
    expect(route).toContain('data-testid="customization-catalog-layout"');
    expect(route).toContain("<CustomizationCatalogSidebar");
    expect(route).toContain("globalCustomizationInstalledItems({");
    expect(sidebar).toContain('data-testid="customization-catalog-sidebar"');
    expect(sidebar).toContain('id: "plugins"');
    expect(sidebar).toContain('id: "skills"');
    expect(sidebar).toContain('id: "connectors"');
  });

  test("labels the Automation hover tooltip as scheduled tasks", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const automation = source.slice(source.indexOf('label={t("navigation.automations")}'), source.indexOf('</RailButton>', source.indexOf('label={t("navigation.automations")}')));
    expect(automation).toContain('tooltipLabel={t("automation.tabs.tasks")}');
  });

  test("keeps selected Automation, Tasks, Calendar, and Toon Factory icon details visible", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const automationIcon = source.slice(source.indexOf("function AutomationRailIcon"), source.indexOf("function TaskRailIcon"));
    const taskIcon = source.slice(source.indexOf("function TaskRailIcon"), source.indexOf("function CalendarRailIcon"));
    const calendarIcon = source.slice(source.indexOf("function CalendarRailIcon"), source.indexOf("function ToonFactoryRailIcon"));
    const toonFactoryIcon = source.slice(source.indexOf("function ToonFactoryRailIcon"), source.indexOf("function RailButton"));
    expect(automationIcon).toContain('stroke={detailColor} data-automation-clock-hands');
    expect(taskIcon).toContain('active ? "var(--dls-active)" : "currentColor"');
    expect(taskIcon).toContain('stroke={detailColor}');
    expect(taskIcon).toContain('data-task-rail-check');
    expect(calendarIcon).toContain('active ? "var(--dls-active)" : "currentColor"');
    expect(calendarIcon).toContain('stroke={detailColor} data-calendar-rail-header');
    expect(calendarIcon).toContain('stroke={detailColor} strokeWidth="2.4" data-calendar-rail-dates');
    expect(source).toContain('<CalendarRailIcon active={calendarActive} />');
    expect(toonFactoryIcon.match(/data-toon-factory-clapper-detail/g)).toHaveLength(2);
    expect(toonFactoryIcon).toContain('active ? "var(--dls-active)" : "currentColor"');
    expect(toonFactoryIcon).toContain('const bodyStroke = active ? "none" : "currentColor"');
    expect(toonFactoryIcon.match(/stroke=\{bodyStroke\}/g)).toHaveLength(2);
  });

  test("routes hover previews only for Rail destinations with workspace menus", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const local = source.slice(source.indexOf('testId="app-rail-home"') - 360, source.indexOf('testId="app-rail-home"') + 520);
    const automation = source.slice(source.indexOf('testId="app-rail-automations"') - 360, source.indexOf('testId="app-rail-automations"') + 360);
    expect(local).toContain('previewScope="local"');
    expect(local).toContain('onWorkspacePreviewOpen={appSidebarPreview.closePreview}');
    expect(local).toContain('onWorkspacePreviewChange={appSidebarPreview.onWorkspaceTriggerChange}');
    expect(local).toContain('showTooltip={!props.suppressPreviewMenuTooltips}');
    expect(source).not.toContain('testId="app-rail-cloud-tasks"');
    expect(source).not.toContain('previewScope="remote"');
    expect(automation).not.toContain('previewScope=');
    expect(automation).not.toContain('showTooltip={!props.suppressPreviewMenuTooltips}');
    expect(source).toContain('onPreviewMenuChange?.(previewScope ?? null)');
    expect(source).toContain('onAppPreviewChange?.(appPreviewTarget, true)');
    expect(source).toContain('onAppPreviewChange?.(appPreviewTarget, false)');
    expect(source).toContain('title={showTooltip ? label : undefined}');
  });

  test("omits the cloud workspace destination from the primary Rail", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-cloud-tasks"');
    expect(source).not.toContain('label={t("navigation.cloud_workspace")}');
    expect(source).not.toContain('<Cloud className="size-5"');
  });

  test("routes Automation and Plugins hover to the global sidebar preview host", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const automation = source.slice(source.indexOf('label={t("navigation.automations")}'), source.indexOf('</RailButton>', source.indexOf('label={t("navigation.automations")}')));
    const plugins = source.slice(source.indexOf('label={t("project_extensions.group_plugin")}'), source.indexOf('<PluginOrbitIcon />'));
    expect(automation).toContain('appPreviewTarget="automation"');
    expect(automation).toContain('onAppPreviewChange={appSidebarPreview.onTriggerChange}');
    expect(automation).toContain('showTooltip={!appSidebarPreview.enabled}');
    expect(plugins).toContain('appPreviewTarget="plugins"');
    expect(plugins).toContain('onAppPreviewChange={appSidebarPreview.onTriggerChange}');
    expect(plugins).toContain('showTooltip={!appSidebarPreview.enabled}');
  });
});

describe("chat unread reminder", () => {
  test("uses a small red dot instead of the unread count", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const chat = source.slice(source.indexOf('label={t("navigation.chat")}'), source.indexOf("<MessageSquare />"));
    expect(chat).toMatch(/badgeVariant="dot"/);
  });

  test("shows Chat and Contacts only with current IM bootstrap availability", () => {
    const im = { provider: "juggleim", websocketUrl: "wss://im.example.com", appKey: "app", imUserId: "user", token: "token" };
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: "org", im })).toBe(true);
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: "org", im: null })).toBe(false);
    expect(isIMNavigationVisible({ authStatus: "checking", activeOrganizationId: "org", im })).toBe(false);
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: null, im })).toBe(false);
  });

  test("keeps Chat and Contacts visible while account details refresh", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-status.ts", import.meta.url), "utf8");
    expect(source).not.toContain("accountBusy");
  });

  test("gates the Chat and Contacts buttons as one block", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("{imNavigationVisible ? ("), source.indexOf("</nav>"));
    expect(block).toContain('testId="app-rail-chat"');
    expect(block).toContain('testId="app-rail-contacts"');
    expect(block).toContain(") : null}");
  });
});

describe("account menu", () => {
  test("shows manual download and install-ready controls immediately above the account avatar", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const updateControl = source.indexOf('testId="app-rail-desktop-update"');
    const accountTrigger = source.indexOf('data-testid="app-rail-account-menu"');
    expect(source).toContain("useDesktopUpdateIndicatorStore");
    expect(updateControl).toBeGreaterThan(0);
    expect(updateControl).toBeLessThan(accountTrigger);
    expect(source).toContain('desktopUpdateState === "available"');
    expect(source).toContain("desktopUpdateController.downloadUpdate()");
    expect(source).toContain('desktopUpdateState === "ready"');
    expect(source).toContain("desktopUpdateController.installUpdateAndRestart()");
    expect(source).toContain('disabled={desktopUpdateState === "downloading"}');
    expect(source).toContain('<Download className="size-4" />');
    expect(source).toContain('<PackageCheck className="size-4" />');
  });

  test("moves the settings notification dot into the bottom account trigger and settings row", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-settings"');
    expect(source).toContain('data-testid="app-rail-account-menu"');
    expect(source).toContain('data-testid="account-menu-settings"');
    expect(source).toMatch(/data-rail-unread-dot/);
    expect(source).toMatch(/right-0 top-0 size-2\.5[^\"]+bg-red-9/);
    expect(source).toMatch(/-right-0\.5 -top-0\.5 size-2\.5[^\"]+bg-red-9/);
    expect(source).toMatch(/badgeVariant === "dot"[\s\S]+aria-hidden="true"/);
  });

  test("keeps only the avatar in the bottom-left trigger", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const trigger = source.slice(source.indexOf('data-testid="app-rail-account-menu"'), source.indexOf("</button>", source.indexOf('data-testid="app-rail-account-menu"')));
    expect(trigger).toContain("<Avatar");
    expect(trigger).not.toContain("{tierLabel} · {organizationLabel}");
    expect(trigger).not.toContain("w-[220px]");
  });

  test("includes the requested account actions and organization submenu", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="account-menu-upgrade"');
    expect(source).toContain('data-testid="account-menu-balance"');
    expect(source).toContain('data-testid="account-menu-check-updates"');
    expect(source).toContain('data-testid="account-menu-help-feedback"');
    expect(source).toContain('data-testid="account-menu-switch-organization"');
    expect(source).toContain('data-testid="account-menu-management-console"');
    expect(source.indexOf('data-testid="account-menu-management-console"')).toBeGreaterThan(
      source.indexOf('data-testid="account-menu-switch-organization"'),
    );
    expect(source).toContain('data-testid="account-menu-sign-out"');
    expect(source).toContain('setAccountMenuOpen(false)');
    expect(source).toContain('disabled={signOutBusy || authStatus === "signed_out"}');
    expect(source).not.toContain('disabled={!user || accountBusy}');
    expect(source).toContain("<DropdownMenuSubContent");
    expect(source).toContain("organizationGroups.personal.map");
    expect(source).toContain("organizationGroups.others.map");
    expect(source).toContain("<DropdownMenuSeparator />");
  });

  test("opens the server-owned membership selector from the upgrade button", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain("membershipUpgradeContext(tenantAccount, activeOrganization)");
    expect(source).toContain("buildDenMembershipUpgradeUrl(readDenSettings().baseUrl, upgradeContext)");
    expect(source).toContain("{upgradeContext ? (");
    expect(source).not.toContain("MembershipUpgradeDialog");
  });
});
