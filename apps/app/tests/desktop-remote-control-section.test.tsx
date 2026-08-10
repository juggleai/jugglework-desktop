import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DesktopRemoteControlAgentStatus } from "@jugglework/types/desktop-ipc";
import { RemoteControlActivityIndicator } from "../src/react-app/domains/settings/cloud/desktop-remote-control-section";

function status(overrides: Partial<DesktopRemoteControlAgentStatus> = {}): DesktopRemoteControlAgentStatus {
  return {
    schemaVersion: 1,
    state: "connected",
    started: true,
    connected: true,
    enrolled: true,
    revoked: false,
    localControlEnabled: true,
    activeControlSessionCount: 0,
    controllerDisplayNames: [],
    lifecycleGeneration: 1,
    connectionGeneration: 7,
    lastErrorCode: null,
    ...overrides,
  };
}

describe("Desktop remote-control status presentation", () => {
  test("distinguishes connected transport from active remote control", () => {
    const html = renderToStaticMarkup(
      <RemoteControlActivityIndicator status={status()} busy={false} onStopAll={() => {}} />,
    );
    expect(html).toContain('data-testid="remote-control-transport-connected"');
    expect(html).toContain("传输已连接，当前没有活跃远程控制");
    expect(html).not.toContain("远程控制活跃中");
  });

  test("shows controller names and a direct Stop All action only for active control", () => {
    const html = renderToStaticMarkup(
      <RemoteControlActivityIndicator
        status={status({ activeControlSessionCount: 3, controllerDisplayNames: ["Alice", "Bob"] })}
        busy={false}
        onStopAll={() => {}}
      />,
    );
    expect(html).toContain('data-testid="remote-control-active-indicator"');
    expect(html).toContain("远程控制活跃中");
    expect(html).toContain("3 个控制会话");
    expect(html).toContain("控制者：Alice、Bob");
    expect(html).toContain("全部停止远程控制");
    expect(html).not.toContain("当前没有活跃远程控制");
  });
});
