import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceWire } from "@jugglework/types/workspace";
import { createWorkspaceStore } from "../../desktop/electron/workspace-store.mjs";
import { persistServerWorkspaceState } from "../../server/src/routes/workspaces";
import { mapDesktopWorkspace, mergeRouteWorkspaces, toSessionGroups } from "../src/react-app/shell/route-workspaces";
import { ordinaryWorkspaceId } from "../src/app/lib/workspace-visibility";
import { resolveWorkspaceListSelectedId } from "../src/app/lib/desktop";

test.each([false, true])("server config -> Electron restore -> App merge/default (ordinary=%s)", async (withOrdinary) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-recovery-merge-"));
  const configPath = join(root, "server.json"), userData = join(root, "desktop");
  const previous = process.env.JUGGLEWORK_SERVER_CONFIG;
  process.env.JUGGLEWORK_SERVER_CONFIG = configPath;
  try {
    const workspaces: WorkspaceWire[] = [];
    for (const id of ["assistant-root", "file-a", "file-b", ...(withOrdinary ? ["normal"] : [])]) {
      const path = join(root, id);
      await mkdir(path);
      workspaces.push({ id, path, name: id, preset: "starter", workspaceType: "local", ...(id !== "normal" ? { fileAssistantManaged: true } : {}) });
    }
    // 使用真正的 Server 配置序列化和 Electron 恢复，不手工构造恢复结果。
    await persistServerWorkspaceState({ configPath, workspaces, authorizedRoots: [] } as any);
    const store = createWorkspaceStore({ app: { getPath: () => userData },
      defaultDenBaseUrl: "https://example.test", defaultRequireSignin: false, forceRequireSignin: false });
    const recovered = await store.readWorkspaceState();
    const persisted = JSON.parse(await readFile(join(userData, "jugglework-workspaces.json"), "utf8"));
    expect(persisted.workspaces.filter((workspace: WorkspaceWire) => workspace.fileAssistantManaged)).toHaveLength(3);
    const restored = await store.readWorkspaceState();
    const desktop = restored.workspaces.map(mapDesktopWorkspace);
    for (const server of [workspaces, workspaces.map(({ fileAssistantManaged: _marker, ...workspace }) => workspace)]) {
      const merged = mergeRouteWorkspaces(server, desktop);
      expect(merged.map((workspace) => workspace.id)).toEqual(withOrdinary ? ["normal"] : []);
      const expectedId = withOrdinary ? "normal" : "";
      expect(ordinaryWorkspaceId(merged, "file-a", recovered.selectedId)).toBe(expectedId);
      expect(resolveWorkspaceListSelectedId({ workspaces: merged, selectedId: "file-b", activeId: "assistant-root" })).toBe(expectedId);
      expect(toSessionGroups(merged, {}, {}, new Set()).map((group) => group.workspace.id)).toEqual(withOrdinary ? ["normal"] : []);
    }
    expect(recovered.selectedId).toBe(withOrdinary ? "normal" : "");
    expect(recovered.activeId).toBe(withOrdinary ? "normal" : null);
  } finally {
    if (previous === undefined) delete process.env.JUGGLEWORK_SERVER_CONFIG; else process.env.JUGGLEWORK_SERVER_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("server known marked IDs exclude stale Desktop duplicates and exact routes retain the marker", () => {
  const internal: WorkspaceWire = { id: "file", path: "/opaque", name: "File", preset: "starter", workspaceType: "local", fileAssistantManaged: true };
  const { fileAssistantManaged: _marker, ...stale } = internal;
  expect(mergeRouteWorkspaces([internal], [mapDesktopWorkspace(stale)])).toEqual([]);
  expect(mergeRouteWorkspaces([stale], [mapDesktopWorkspace(internal)])).toEqual([]);
  for (const [server, desktop] of [[internal, stale], [stale, internal]] as const) {
    const exact = mergeRouteWorkspaces([server], [mapDesktopWorkspace(desktop)], "file");
    expect(exact).toHaveLength(1);
    expect(exact[0]?.fileAssistantManaged).toBe(true);
    expect(ordinaryWorkspaceId(exact, "file")).toBe("");
  }
  // 不按目录名称推断分类，正常同名目录仍是普通工作区。
  expect(mergeRouteWorkspaces([{ ...stale, path: "/FileAssistant/files/hash" }], []).map((workspace) => workspace.id)).toEqual(["file"]);
});
