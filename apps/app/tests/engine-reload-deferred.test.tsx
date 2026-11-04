import * as React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { readFileSync } from "node:fs";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import {
  useSystemState,
  type SystemStateControls,
} from "../src/react-app/kernel/system-state";

let view: ReactTestRenderer | null = null;
let latest: SystemStateControls | null = null;
const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

function Probe(props: { reload: () => Promise<boolean>; workspaceId?: string | null }) {
  latest = useSystemState({
    hasActiveRuns: () => false,
    reloadWorkspaceEngine: props.reload,
    setError: () => {},
    currentWorkspaceId: props.workspaceId,
  });
  return null;
}

const config = { type: "config", name: "opencode.json", action: "updated" } as const;

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
});

afterEach(async () => {
  await act(async () => view?.unmount());
  view = null;
  latest = null;
});

describe("deferred engine reload recovery", () => {
  test("keeps a server-fenced reload pending without creating a sticky error", async () => {
    await act(async () => {
      view = create(<Probe reload={async () => {
        throw new JuggleWorkServerError(
          409,
          "engine_reload_blocked_active_runs",
          "Configuration reload is deferred until all active tasks finish",
        );
      }} />);
    });

    await act(async () => {
      await latest!.reloadWorkspaceEngine();
    });

    expect(latest!.reload.reloadPending).toBe(true);
    expect(latest!.reload.reloadBusy).toBe(false);
    expect(latest!.reload.reloadError).toBeNull();
  });

  test("keeps genuine reload failures visible", async () => {
    await act(async () => {
      view = create(<Probe reload={async () => {
        throw new Error("engine restart failed");
      }} />);
    });

    await act(async () => {
      await latest!.reloadWorkspaceEngine();
    });

    expect(latest!.reload.reloadPending).toBe(false);
    expect(latest!.reload.reloadError).toBe("engine restart failed");
  });

  test("reload errors remain visible without disabling task submission", () => {
    const route = readFileSync(
      new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
      "utf8",
    );
    const page = readFileSync(
      new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url),
      "utf8",
    );

    expect(route).not.toContain("!reloadCoordinator.reloadError &&");
    expect(route).not.toContain("reloadBusy={reloadCoordinator.reloadBusy || Boolean(reloadCoordinator.reloadError)}");
    expect(page).not.toContain("&& !props.statusBar?.reloadError");
  });

  test("a workspace-scoped pending reload survives another workspace's reload", async () => {
    const ok = async () => true;
    await act(async () => {
      view = create(<Probe reload={ok} workspaceId="ws_a" />);
    });
    await act(async () => {
      latest!.markReloadRequired("config", config, { workspaceId: "ws_a" });
    });
    expect(latest!.reload.reloadPending).toBe(true);

    // User switches to B: A's pending is not current for B, so B does not
    // auto-reload for it, but it is retained.
    await act(async () => {
      view!.update(<Probe reload={ok} workspaceId="ws_b" />);
    });
    expect(latest!.reload.reloadPending).toBe(false);
    expect(latest!.reload.pendingWorkspaceIds).toEqual(["ws_a"]);

    // A reload of B (e.g. for B's own unscoped change) does not clear A.
    await act(async () => {
      latest!.markReloadRequired("skills");
    });
    expect(latest!.reload.reloadPending).toBe(true);
    await act(async () => {
      await latest!.reloadWorkspaceEngine();
    });
    expect(latest!.reload.reloadPending).toBe(false);
    expect(latest!.reload.pendingWorkspaceIds).toEqual(["ws_a"]);

    // Back on A: pending again, so the coordinator's idle auto-reload fires.
    await act(async () => {
      view!.update(<Probe reload={ok} workspaceId="ws_a" />);
    });
    expect(latest!.reload.reloadPending).toBe(true);
    await act(async () => {
      await latest!.reloadWorkspaceEngine();
    });
    expect(latest!.reload.reloadPending).toBe(false);
    expect(latest!.reload.pendingWorkspaceIds).toEqual([]);
    expect(latest!.reload.reloadReasons).toEqual([]);
  });

  test("a deferred reload keeps the scoped workspace pending", async () => {
    await act(async () => {
      view = create(<Probe workspaceId="ws_a" reload={async () => {
        throw new JuggleWorkServerError(
          409,
          "engine_reload_blocked_active_runs",
          "Configuration reload is deferred until all active tasks finish",
        );
      }} />);
    });
    await act(async () => {
      latest!.markReloadRequired("config", config, { workspaceId: "ws_a" });
    });
    await act(async () => {
      await latest!.reloadWorkspaceEngine();
    });
    expect(latest!.reload.reloadPending).toBe(true);
    expect(latest!.reload.pendingWorkspaceIds).toEqual(["ws_a"]);
    expect(latest!.reload.reloadError).toBeNull();
  });

  test("an unscoped clear still clears everything", async () => {
    await act(async () => {
      view = create(<Probe reload={async () => true} workspaceId="ws_b" />);
    });
    await act(async () => {
      latest!.markReloadRequired("config", config, { workspaceId: "ws_a" });
      latest!.markReloadRequired("mcp");
    });
    await act(async () => {
      latest!.clearReloadRequired();
    });
    expect(latest!.reload.reloadPending).toBe(false);
    expect(latest!.reload.pendingWorkspaceIds).toEqual([]);
  });
});
