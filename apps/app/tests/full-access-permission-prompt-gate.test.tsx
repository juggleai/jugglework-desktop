import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PendingPermission } from "../src/app/types";
import type { SessionPermissionEffectiveMode } from "@jugglework/types/session-permission-modes";
import {
  FULL_ACCESS_PROMPT_GRACE_MS,
  useFullAccessPermissionPromptGate,
} from "../src/react-app/domains/session/surface/full-access-permission-prompt-gate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEST_GRACE_MS = 20;

function permissionFixture(id: string): PendingPermission {
  return {
    id,
    targetSessionId: "ses_root",
    parentSessionId: null,
    rootSessionId: "ses_root",
    ancestryPath: [],
    receivedAt: Date.now(),
    interactionRevision: 1,
    protocol: "v2",
  } as unknown as PendingPermission;
}

function GateProbe(props: {
  permission: PendingPermission | null;
  mode: SessionPermissionEffectiveMode | null;
  graceMs?: number;
}) {
  const gated = useFullAccessPermissionPromptGate(props.permission, props.mode, props.graceMs ?? TEST_GRACE_MS);
  return <>{gated ? "shown" : "hidden"}</>;
}

function text(root: TestRenderer.ReactTestRenderer) {
  return root.toJSON() as unknown as string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function renderGate(initial: { permission: PendingPermission | null; mode: SessionPermissionEffectiveMode | null }) {
  let current = initial;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<GateProbe permission={current.permission} mode={current.mode} />);
  });
  return {
    get text() { return text(renderer!); },
    async update(next: { permission: PendingPermission | null; mode: SessionPermissionEffectiveMode | null }) {
      current = next;
      await act(async () => {
        renderer!.update(<GateProbe permission={current.permission} mode={current.mode} />);
      });
    },
  };
}

describe("useFullAccessPermissionPromptGate", () => {
  test("reveals immediately under request-approval", async () => {
    const gate = await renderGate({ permission: permissionFixture("p1"), mode: "request-approval" });
    expect(gate.text).toBe("shown");
  });

  test("reveals immediately when the mode is unknown or loading", async () => {
    const gate = await renderGate({ permission: permissionFixture("p1"), mode: null });
    expect(gate.text).toBe("shown");
  });

  test("paused and suspended full-access never suppress the prompt", async () => {
    for (const mode of ["full-access-paused", "full-access-suspended"] as const) {
      const gate = await renderGate({ permission: permissionFixture("p1"), mode });
      expect(gate.text).toBe("shown");
    }
  });

  test("suppresses under full-access, then reveals after the grace window", async () => {
    const gate = await renderGate({ permission: permissionFixture("p1"), mode: "full-access" });
    expect(gate.text).toBe("hidden");
    await act(async () => { await sleep(TEST_GRACE_MS + 40); });
    expect(gate.text).toBe("shown");
  });

  test("reveals immediately when the mode leaves full-access while suppressed", async () => {
    const gate = await renderGate({ permission: permissionFixture("p1"), mode: "full-access" });
    expect(gate.text).toBe("hidden");
    await gate.update({ permission: permissionFixture("p1"), mode: "request-approval" });
    expect(gate.text).toBe("shown");
  });

  test("never hides a prompt that was already visible", async () => {
    const permission = permissionFixture("p1");
    const gate = await renderGate({ permission, mode: "request-approval" });
    expect(gate.text).toBe("shown");
    await gate.update({ permission, mode: "full-access" });
    expect(gate.text).toBe("shown");
  });

  test("a new permission id starts a fresh grace window", async () => {
    const gate = await renderGate({ permission: permissionFixture("p1"), mode: "full-access" });
    expect(gate.text).toBe("hidden");
    await gate.update({ permission: permissionFixture("p2"), mode: "full-access" });
    expect(gate.text).toBe("hidden");
    await act(async () => { await sleep(TEST_GRACE_MS + 40); });
    expect(gate.text).toBe("shown");
  });

  test("returns null when there is no pending permission", async () => {
    const gate = await renderGate({ permission: null, mode: "full-access" });
    expect(gate.text).toBe("hidden");
  });

  test("default grace covers the broker polling cadence", () => {
    // Server broker default poll interval is 1.2s; the grace must exceed
    // poll + snapshot/dispatch latency with margin.
    expect(FULL_ACCESS_PROMPT_GRACE_MS).toBeGreaterThan(1_200);
  });
});
