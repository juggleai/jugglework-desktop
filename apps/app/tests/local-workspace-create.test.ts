import { describe, expect, test } from "bun:test";

import { createLocalWorkspaceForRuntime } from "../src/app/lib/local-workspace-create";

const workspace = {
  id: "ws_server_owned",
  name: "project",
  path: "/tmp/project",
  preset: "starter",
  workspaceType: "local" as const,
};

describe("createLocalWorkspaceForRuntime", () => {
  test("creates on the server before mirroring the server-owned ID to Desktop", async () => {
    const calls: string[] = [];
    const client = {
      createLocalWorkspace: async () => {
        calls.push("server");
        return { activeId: workspace.id, workspaces: [workspace] };
      },
    };

    const result = await createLocalWorkspaceForRuntime(
      client,
      { folderPath: workspace.path, name: workspace.name, preset: workspace.preset },
      {
        isDesktopRuntime: () => true,
        workspaceCreate: async (input) => {
          calls.push("desktop");
          expect(input.workspaceId).toBe(workspace.id);
          return { selectedId: workspace.id, workspaces: [workspace] };
        },
      },
    );

    expect(calls).toEqual(["server", "desktop"]);
    expect(result.workspaceId).toBe(workspace.id);
  });

  test("does not touch the Desktop registry in a browser runtime", async () => {
    let desktopCalls = 0;
    const result = await createLocalWorkspaceForRuntime(
      {
        createLocalWorkspace: async () => ({ activeId: workspace.id, workspaces: [workspace] }),
      },
      { folderPath: workspace.path, name: workspace.name, preset: workspace.preset },
      {
        isDesktopRuntime: () => false,
        workspaceCreate: async () => {
          desktopCalls += 1;
          return { workspaces: [] };
        },
      },
    );

    expect(desktopCalls).toBe(0);
    expect(result.workspace).toEqual(workspace);
  });

  test("does not touch the Desktop registry when server creation fails", async () => {
    let desktopCalls = 0;
    await expect(createLocalWorkspaceForRuntime(
      {
        createLocalWorkspace: async () => {
          throw new Error("server unavailable");
        },
      },
      { folderPath: workspace.path, name: workspace.name, preset: workspace.preset },
      {
        isDesktopRuntime: () => true,
        workspaceCreate: async () => {
          desktopCalls += 1;
          return { workspaces: [] };
        },
      },
    )).rejects.toThrow("server unavailable");
    expect(desktopCalls).toBe(0);
  });

  test("rejects a Desktop mirror that loses the server workspace ID", async () => {
    await expect(createLocalWorkspaceForRuntime(
      {
        createLocalWorkspace: async () => ({ activeId: workspace.id, workspaces: [workspace] }),
      },
      { folderPath: workspace.path, name: workspace.name, preset: workspace.preset },
      {
        isDesktopRuntime: () => true,
        workspaceCreate: async () => ({ workspaces: [{ ...workspace, id: "ws_wrong" }] }),
      },
    )).rejects.toThrow("did not preserve");
  });
});
