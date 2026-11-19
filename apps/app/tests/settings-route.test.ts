import { describe, expect, mock, test } from "bun:test";

// 路由解析无需初始化依赖浏览器存储的原生 IM SDK。
mock.module("../src/react-app/domains/jugglechat/runtime", () => ({ juggleChatRuntime: {} }));
const { parseSettingsPath } = await import("../src/react-app/shell/settings-route");

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
