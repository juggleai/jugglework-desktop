/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import TestRenderer, { act } from "react-test-renderer";

import { setLocale, t } from "../src/i18n";

mock.module("../src/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => children,
  PopoverTrigger: ({ render }: { render: unknown }) => render,
  PopoverContent: ({ children }: { children: unknown }) => children,
}));

const { SessionHomeEntry } = await import("../src/react-app/domains/session/surface/session-home-entry");

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 0, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
afterEach(() => setLocale("en"));

const home = {
  workspaces: [{ id: "ws_office", label: "日常办公", remote: false }],
  onSelectWorkspace: () => {},
};

function render(onCreateTask: (prompt?: string) => void, disabled = false) {
  let view: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    view = TestRenderer.create(
      <SessionHomeEntry appName="北数Work" workspaceId="ws_office" home={home} onCreateTask={onCreateTask} disabled={disabled} />,
    );
  });
  return view!;
}

test("a scenario chip creates a task with its prompt template", () => {
  setLocale("zh");
  const create = mock((_prompt?: string) => {});
  const view = render(create);
  act(() => view.root.findByProps({ "data-testid": "session-home-scenario-data" }).props.onClick());
  expect(create).toHaveBeenCalledWith(t("session.home_scenario_data_prompt"));
});

test("Enter creates a task carrying the typed text; Shift+Enter and IME composition do not", () => {
  const create = mock((_prompt?: string) => {});
  const view = render(create);
  const input = () => view.root.findByProps({ "data-testid": "session-home-entry-input" });
  act(() => input().props.onChange({ target: { value: "写一份周报" } }));
  const key = (extra: object) => {
    const preventDefault = mock(() => {});
    act(() => input().props.onKeyDown({ key: "Enter", shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault, ...extra }));
  };
  key({ shiftKey: true });
  key({ nativeEvent: { isComposing: true } });
  key({ keyCode: 229 });
  expect(create).not.toHaveBeenCalled();
  key({});
  expect(create).toHaveBeenCalledWith("写一份周报");
});

test("the send button with empty text creates a blank task, and disabled blocks creation", () => {
  const create = mock((_prompt?: string) => {});
  const view = render(create);
  act(() => view.root.findByProps({ "data-testid": "session-home-entry-submit" }).props.onClick());
  expect(create).toHaveBeenCalledWith(undefined);

  const blocked = mock((_prompt?: string) => {});
  const blockedView = render(blocked, true);
  act(() => blockedView.root.findByProps({ "data-testid": "session-home-entry-submit" }).props.onClick());
  expect(blocked).not.toHaveBeenCalled();
});

test("the no-session page shows the home instead of the old starter cards", () => {
  const page = readFileSync(new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url), "utf8");
  expect(page).toContain("<SessionHomeEntry");
  expect(page).not.toContain("session.select_or_create_session");
  expect(page).not.toContain("session.new_session_csv_prompt");
  const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
  expect(route).toContain("home={sessionHomeOptions}");
});
