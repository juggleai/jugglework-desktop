import { afterEach, expect, test } from "bun:test";
import type { JuggleWorkSessionSnapshot } from "../src/app/lib/jugglework-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  captureSessionSnapshotRevision,
  captureSessionTitleRevision,
  ensureWorkspaceSessionSync,
  reconcileSessionSnapshotTitle,
  snapshotKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { reconcileWorkspaceSessionTitles } from "../src/react-app/shell/workspace-routes";

afterEach(() => getReactQueryClient().clear());

test("untracked background metadata reaches its workspace and cached snapshot without clearing revert", () => {
  const updates: unknown[] = [];
  const input = { workspaceId: "metadata-background", baseUrl: "http://unused", juggleworkToken: "test", onSessionUpdated: (update: unknown) => updates.push(update) };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  try {
    const key = snapshotKey(input.workspaceId, "session-a");
    getReactQueryClient().setQueryData(key, {
      session: { id: "session-a", title: "New session", revert: { messageID: "message-a" } },
    });
    __applySessionSyncEventForTest(input, {
      type: "session.updated", properties: { info: { id: "session-a", title: "Named task" } },
    } as never);
    expect(updates).toEqual([{ sessionId: "session-a", info: { id: "session-a", title: "Named task" } }]);
    expect(getReactQueryClient().getQueryData(key)).toMatchObject({
      session: { title: "Named task", revert: { messageID: "message-a" } },
    });
  } finally { dispose(); }
});

test("late snapshot retains a live title, but a later authoritative read can rename it again", () => {
  const input = { workspaceId: "metadata-snapshot", baseUrl: "http://unused", juggleworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  try {
    const revision = captureSessionSnapshotRevision(input.workspaceId, "session-a");
    const titleRevision = captureSessionTitleRevision();
    __applySessionSyncEventForTest(input, {
      type: "session.updated", properties: { info: { id: "session-a", title: "Live title" } },
    } as never);
    const snapshot = { session: { id: "session-a", title: "Old title" } } as JuggleWorkSessionSnapshot;
    expect(reconcileSessionSnapshotTitle(input.workspaceId, snapshot, revision, titleRevision).session.title).toBe("Live title");
    expect(reconcileSessionSnapshotTitle(input.workspaceId, snapshot, revision, captureSessionTitleRevision()).session.title).toBe("Old title");
    expect(reconcileSessionSnapshotTitle("other-workspace", snapshot, revision, titleRevision).session.title).toBe("Old title");
  } finally { dispose(); }
});

test("a full session update clears an omitted revert cursor without dropping the title", () => {
  const input = { workspaceId: "metadata-revert", baseUrl: "http://unused", juggleworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  try {
    const key = snapshotKey(input.workspaceId, "session-a");
    getReactQueryClient().setQueryData(key, {
      session: { id: "session-a", title: "Old", revert: { messageID: "message-a" } },
    });
    __applySessionSyncEventForTest(input, {
      type: "session.updated", properties: { info: {
        id: "session-a", title: "Named task", directory: "/test", time: { created: 1, updated: 2 },
      } },
    } as never);
    const snapshot = getReactQueryClient().getQueryData<JuggleWorkSessionSnapshot>(key)!;
    expect(snapshot.session.title).toBe("Named task");
    expect(snapshot.session.revert).toBeUndefined();
  } finally { dispose(); }
});

test("list refresh keeps concurrent renames including newly inserted sessions, and accepts missed offline titles", () => {
  const started = [{ id: "a", title: "New session" }, { id: "b", title: "Before disconnect" }];
  const current = [{ id: "a", title: "Live rename" }, started[1]!, { id: "c", title: "Created and renamed" }];
  expect(reconcileWorkspaceSessionTitles([
    { id: "a", title: "New session" }, { id: "b", title: "Renamed offline" }, { id: "c", title: "New session" },
  ], started, current)).toEqual([
    { id: "a", title: "Live rename" }, { id: "b", title: "Renamed offline" }, { id: "c", title: "Created and renamed" },
  ]);
});

test("workspace metadata subscribers survive selection changes and receive reconnect calibration", async () => {
  let connections = 0;
  let calibrations = 0;
  let reconnected!: () => void;
  const ready = new Promise<void>((resolve) => { reconnected = resolve; });
  const updates: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch() {
      connections += 1;
      const attempt = connections;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.updated", properties: { info: { id: "background", title: `Title ${attempt}` } } })}\n\n`));
          if (attempt === 1) controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const input = { workspaceId: "metadata-reconnect", baseUrl: `http://127.0.0.1:${server.port}`, juggleworkToken: "test" };
  const releaseSidebar = ensureWorkspaceSessionSync({ ...input,
    onSessionUpdated: ({ info }) => updates.push(String(info.title)),
    onReconnect: () => { if (++calibrations === 2) reconnected(); },
  });
  const releaseSelected = ensureWorkspaceSessionSync(input);
  releaseSelected(); // Switching away must not release the sidebar subscription.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Reconnect timed out")), 4_000);
    })]);
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(calibrations).toBe(2);
    expect(updates).toContain("Title 1");
  } finally {
    clearTimeout(timeout);
    releaseSidebar();
    server.stop(true);
  }
}, 5_000);
