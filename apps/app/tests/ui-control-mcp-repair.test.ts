import { describe, expect, test } from "bun:test";

import {
  bundledUiControlMcpMigrationPatch,
  canAttemptBundledUiControlMcpRepair,
  isManagedBundledUiControlMcpCommand,
  mergeBundledUiControlMcpEnvironment,
  isLegacyUiControlMcpCommand,
  needsBundledUiControlMcpRepair,
} from "../src/react-app/domains/connections/ui-control-mcp-repair";

const command = ["/Applications/JuggleWork.app/Contents/MacOS/JuggleWork", "/Applications/JuggleWork.app/Contents/Resources/jugglework-ui-mcp/index.mjs"];
const environment = {
  ELECTRON_RUN_AS_NODE: "1",
  JUGGLEWORK_UI_CONTROL_DISCOVERY: "/Users/test/Library/Application Support/com.juggleai.jugglework/jugglework-ui-control.json",
};

describe("bundled UI control MCP repair", () => {
  test("runs only for a desktop-local workspace backed by the loopback server", () => {
    expect(canAttemptBundledUiControlMcpRepair({ desktopRuntime: true, workspaceType: "local", embeddedServer: true })).toBe(true);
    expect(canAttemptBundledUiControlMcpRepair({ desktopRuntime: true, workspaceType: "remote", embeddedServer: true })).toBe(false);
    expect(canAttemptBundledUiControlMcpRepair({ desktopRuntime: true, workspaceType: "local", embeddedServer: false })).toBe(false);
    expect(canAttemptBundledUiControlMcpRepair({ desktopRuntime: false, workspaceType: "local", embeddedServer: true })).toBe(false);
  });

  test("mandatory bundled environment overrides conflicting configured values", () => {
    expect(mergeBundledUiControlMcpEnvironment({
      CUSTOM: "keep",
      ELECTRON_RUN_AS_NODE: "0",
      JUGGLEWORK_UI_CONTROL_DISCOVERY: "/wrong/discovery.json",
    }, environment)).toEqual({ CUSTOM: "keep", ...environment });
  });

  test("repairs the legacy npm command", () => {
    expect(needsBundledUiControlMcpRepair({
      name: "jugglework-ui",
      config: {
        type: "local",
        enabled: true,
        command: ["npx", "-y", "jugglework-ui-mcp"],
        environment: { JUGGLEWORK_UI_CONTROL_DISCOVERY: environment.JUGGLEWORK_UI_CONTROL_DISCOVERY },
      },
    }, command, environment)).toBe(true);
  });

  test("keeps the current bundled command", () => {
    expect(needsBundledUiControlMcpRepair({
      name: "jugglework-ui",
      config: { type: "local", enabled: true, command, environment },
    }, command, environment)).toBe(false);
  });

  test("upgrades a prior app-managed bundle while preserving custom profile commands", () => {
    const priorCommand = [
      "/Applications/JuggleWork.app/Contents/MacOS/JuggleWork",
      "/Users/test/Library/Application Support/com.juggleai.jugglework/runtime/jugglework-ui-mcp/1.2.12/index.mjs",
    ];
    const desiredCommand = [
      "/Applications/JuggleWork.app/Contents/MacOS/JuggleWork",
      "/Users/test/Library/Application Support/com.juggleai.jugglework/runtime/jugglework-ui-mcp/1.2.13/index.mjs",
    ];
    expect(isManagedBundledUiControlMcpCommand(priorCommand, desiredCommand)).toBe(true);
    expect(needsBundledUiControlMcpRepair({
      name: "jugglework-ui",
      config: { type: "local", enabled: true, command: priorCommand, environment },
    }, desiredCommand, environment)).toBe(true);
    expect(isManagedBundledUiControlMcpCommand([
      "node",
      "/Users/test/custom/jugglework-ui-mcp/1.2.12/index.mjs",
    ], desiredCommand)).toBe(false);
  });

  test("does not overwrite a custom UI control command", () => {
    expect(needsBundledUiControlMcpRepair({
      name: "jugglework-ui",
      config: { type: "local", enabled: true, command: ["custom-ui-control"], environment: {} },
    }, command, environment)).toBe(false);
  });

  test("recognizes the exact legacy executable on Unix and Windows only", () => {
    expect(isLegacyUiControlMcpCommand(["npx", "-y", "jugglework-ui-mcp"])).toBe(true);
    expect(isLegacyUiControlMcpCommand(["C:\\Program Files\\nodejs\\npx.cmd", "-y", "jugglework-ui-mcp"])).toBe(true);
    expect(isLegacyUiControlMcpCommand(["npx", "--yes", "jugglework-ui-mcp"])).toBe(false);
    expect(isLegacyUiControlMcpCommand(["npx", "-y", "custom-ui-control"])).toBe(false);
  });

  test("migration produces only the command and required environment patch", () => {
    const server = {
      name: "jugglework-ui",
      config: {
        type: "local" as const,
        enabled: true,
        command: ["npx", "-y", "jugglework-ui-mcp"],
        environment: { CUSTOM: "keep" },
        cwd: "/keep/cwd",
        timeout: 9_000,
      },
    };
    expect(bundledUiControlMcpMigrationPatch(server, command, environment)).toEqual({
      command,
      environment,
    });
  });

  test("does not re-enable a connector the user disabled", () => {
    expect(needsBundledUiControlMcpRepair({
      name: "jugglework-ui",
      config: { type: "local", enabled: false, command: ["npx", "-y", "jugglework-ui-mcp"] },
    }, command, environment)).toBe(false);
  });

  test("does not install an absent connector", () => {
    expect(needsBundledUiControlMcpRepair(undefined, command, environment)).toBe(false);
  });
});
