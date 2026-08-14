import { describe, expect, test } from "bun:test";

import { serializeWorkspaceActivation } from "../src/react-app/shell/workspace-activation-coordinator";

describe("workspace activation coordinator", () => {
  test("serializes startup and navigation activation requests", async () => {
    const events: string[] = [];
    let releaseStartup: (() => void) | null = null;
    const startupWait = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });

    const startup = serializeWorkspaceActivation(async () => {
      events.push("startup:start");
      await startupWait;
      events.push("startup:end");
    });
    const navigation = serializeWorkspaceActivation(async () => {
      events.push("navigation:start");
      events.push("navigation:end");
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["startup:start"]);
    releaseStartup?.();
    await Promise.all([startup, navigation]);
    expect(events).toEqual([
      "startup:start",
      "startup:end",
      "navigation:start",
      "navigation:end",
    ]);
  });
});
