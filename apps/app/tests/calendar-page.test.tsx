import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => { consoleError.mockRestore(); });

mock.module("../src/react-app/shell/app-navigation-rail", () => ({
  APP_NAVIGATION_RAIL_WIDTH: 48,
  AppNavigationRail: () => <nav data-testid="mock-app-rail" />,
}));

let cloudSession: Record<string, unknown> = {};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => cloudSession,
}));

let desktopConfig: { loading: boolean; config: Record<string, unknown> } = { loading: false, config: {} };
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => desktopConfig,
}));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");

const noop = () => undefined;
const signedIn = {
  isSignedIn: true,
  baseUrl: "https://den.example/api",
  activeOrganization: { id: "org-a", orgMemberId: "member-a" },
  client: {
    listCalendars: async () => [],
    getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => ({ calendars: [], events: [], coverage: { ...range, calendarIds: [] }, cursor: "c1" }),
  },
};

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/calendar"]}>
        <CalendarPage
          workspaceId=""
          sessionPath="/session"
          onOpenAccount={noop}
          onOpenApps={noop}
          onOpenChat={noop}
          onOpenReviews={noop}
          onOpenSettings={noop}
        />
      </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return renderer;
}

const hasTestId = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
  renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;

test("renders the ready calendar without a workspace, Session, Agent, or AI Provider", async () => {
  cloudSession = signedIn;
  desktopConfig = { loading: false, config: { calendarEnabled: true, calendarWriteEnabled: false } };
  const renderer = await render();
  try {
    expect(hasTestId(renderer, "calendar-page-title")).toBe(true);
    const ready = renderer.root.find((node) => node.props["data-testid"] === "calendar-ready");
    expect(ready.props["data-calendar-write-enabled"]).toBe("false");
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test("shows a sign-in state and no calendar content when signed out", async () => {
  cloudSession = { ...signedIn, isSignedIn: false };
  desktopConfig = { loading: false, config: { calendarEnabled: true, calendarWriteEnabled: true } };
  const renderer = await render();
  try {
    expect(hasTestId(renderer, "calendar-gate-signed-out")).toBe(true);
    expect(hasTestId(renderer, "calendar-ready")).toBe(false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test("fails closed while the capability is unknown or disabled", async () => {
  cloudSession = signedIn;
  desktopConfig = { loading: true, config: {} };
  let renderer = await render();
  try {
    expect(hasTestId(renderer, "calendar-gate-loading")).toBe(true);
    expect(hasTestId(renderer, "calendar-ready")).toBe(false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
  desktopConfig = { loading: false, config: { calendarEnabled: false } };
  renderer = await render();
  try {
    expect(hasTestId(renderer, "calendar-gate-disabled")).toBe(true);
    expect(hasTestId(renderer, "calendar-ready")).toBe(false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test("the calendar domain imports nothing from Session, Agent, workspace, or provider modules", () => {
  const dir = join(import.meta.dir, "../src/react-app/domains/calendar");
  const forbidden = /from\s+["'][^"']*(domains\/session|session-route|opencode|agent|ai-provider|providers\/|workspace\/)[^"']*["']/i;
  for (const file of ["calendar-page.tsx", "calendar-page-gate.ts", "calendar-month-model.ts", "calendar-month-view.tsx", "calendar-view-model.ts", "calendar-view-toolbar.tsx", "calendar-time-layout.ts", "calendar-time-view.tsx", "calendar-event-layout.ts", "calendar-day-events.tsx"]) {
    const source = readFileSync(join(dir, file), "utf8");
    expect({ file, match: source.match(forbidden)?.[0] ?? null }).toEqual({ file, match: null });
  }
});
