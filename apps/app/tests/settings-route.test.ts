import { describe, expect, test } from "bun:test";

import { parseSettingsPath } from "../src/react-app/shell/settings-route";

describe("settings route parsing", () => {
  test("recognizes the Notifications settings tab", () => {
    expect(parseSettingsPath("/settings/notifications")).toEqual({
      tab: "notifications",
      redirectPath: null,
    });
  });

  test("recognizes the Connect settings tab", () => {
    expect(parseSettingsPath("/settings/connect")).toEqual({ tab: "connect", redirectPath: null });
    expect(parseSettingsPath("/workspace/workspace_1/settings/connect")).toEqual({
      tab: "connect",
      redirectPath: null,
    });
  });
});
