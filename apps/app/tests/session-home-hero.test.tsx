/** @jsxImportSource react */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import TestRenderer, { act } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale, t } from "../src/i18n";
import { OFFICE_SCENARIOS, SessionHomeScenarios, SessionHomeTitle } from "../src/react-app/domains/session/surface/session-home-hero";

afterEach(() => setLocale("en"));

describe("session home hero", () => {
  test("renders the brand title and one row of office scenarios in Chinese", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(
      <>
        <SessionHomeTitle appName="北数Work" centered />
        <SessionHomeScenarios onFillPrompt={() => {}} onOpenSchedule={() => {}} />
      </>,
    );

    expect(html).toContain("北数Work，来帮你");
    // 机器人动图在标题上方，使用随包交付的透明 GIF。
    expect(html).toContain('data-testid="session-home-mascot"');
    expect(html).toContain("pets/juggle/typing.gif");
    expect(html.indexOf("session-home-mascot")).toBeLessThan(html.indexOf("北数Work，来帮你"));
    for (const label of ["创作文档", "制作PPT", "分析数据", "深度研究", "策划方案", "定时任务"]) {
      expect(html).toContain(label);
    }
  });

  test("fills a prompt template instead of sending, and opens scheduled tasks for the schedule chip", () => {
    setLocale("zh");
    const fill = mock((_prompt: string) => {});
    const schedule = mock(() => {});
    let view: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      view = TestRenderer.create(<SessionHomeScenarios onFillPrompt={fill} onOpenSchedule={schedule} />);
    });
    const chip = (id: string) => view!.root.findByProps({ "data-testid": `session-home-scenario-${id}` });

    act(() => chip("presentation").props.onClick());
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill.mock.calls[0]![0]).toBe(t("session.home_scenario_presentation_prompt"));
    expect(fill.mock.calls[0]![0]).toContain(".pptx");

    act(() => chip("schedule").props.onClick());
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  test("hides the schedule chip when scheduled tasks are unavailable", () => {
    const html = renderToStaticMarkup(<SessionHomeScenarios onFillPrompt={() => {}} />);
    expect(html).not.toContain('data-testid="session-home-scenario-schedule"');
    expect(OFFICE_SCENARIOS.filter((scenario) => scenario.promptKey !== null)).toHaveLength(5);
  });

  test("every prompt template is translated in zh and en", () => {
    for (const lng of ["zh", "en"] as const) {
      setLocale(lng);
      for (const scenario of OFFICE_SCENARIOS) {
        expect(t(`session.home_scenario_${scenario.id}`)).not.toBe(`session.home_scenario_${scenario.id}`);
        if (scenario.promptKey) expect(t(scenario.promptKey)).not.toBe(scenario.promptKey);
      }
    }
  });
});

describe("session surface home layout", () => {
  const source = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");

  test("shows the home only for a loaded, empty, idle session", () => {
    const gate = source.slice(source.indexOf("const homeVisible = "), source.indexOf("queuedDrafts.length === 0;") + 30);
    for (const condition of [
      "Boolean(props.home)",
      "!fileHost",
      "snapshot!.messages.length === 0",
      "renderedMessages.length === 0",
      'effectiveActivityStatus === "idle"',
      "!chatStreaming",
      "!sending",
      "!submissionPreparing",
      "!error",
    ]) {
      expect(gate).toContain(condition);
    }
  });

  test("moves the permission selector below the composer next to the workspace selector", () => {
    expect(source).toContain("permissionModeSelector={homeVisible ? null : permissionModeSelector}");
    const footer = source.slice(source.indexOf("footerAccessory={homeVisible && props.home ? ("), source.indexOf(") : null}", source.indexOf("footerAccessory={homeVisible")));
    expect(footer).toContain("<WorkspaceSelect");
    expect(footer).toContain("{permissionModeSelector}");
  });

  test("centers the title in the window and keeps chips and composer at the bottom", () => {
    const hero = readFileSync(new URL("../src/react-app/domains/session/surface/session-home-hero.tsx", import.meta.url), "utf8");
    expect(hero).toContain("absolute inset-x-0 top-[38%] -translate-y-1/2");
    expect(hero).toContain("const HOME_TITLE_CENTER_RATIO = 0.38;");
    expect(source).toContain("centered={homeTitleCentered}");
    expect(source).toContain('homeVisible ? "relative overflow-y-auto" : ""');
    const bottom = source.slice(source.indexOf("data-session-home-bottom"), source.indexOf("ref={composerShellRef}"));
    expect(source).toContain('"relative z-10 flex min-h-0 flex-1 flex-col justify-end pb-[4vh]" : "contents"');
    expect(bottom).toContain("<SessionHomeScenarios");
  });

  test("the no-session home fills the content area height", () => {
    const page = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
    expect(page).toContain('? "flex h-full min-h-0 flex-col"');
    expect(page).toContain("const showHomeEntry = Boolean(props.home) &&");
  });

  test("never shows the home in the split-view secondary pane", () => {
    const page = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
    const secondary = page.slice(page.indexOf('data-workbench-pane="secondary"'));
    expect(secondary.slice(0, secondary.indexOf("client={props.juggleworkServerClient!}"))).toContain("home={null}");
  });
});
