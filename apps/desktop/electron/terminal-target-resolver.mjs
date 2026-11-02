import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// No renderer paths or endpoints enter this contract. The managed runtime is
// selected by main, and the desktop store independently vetoes remote targets.
export function createTerminalTargetResolver({ workspaceStore, client }) {
  return async (target) => {
    const { workspaceId, sessionId } = target ?? {};
    for (const id of [workspaceId, sessionId]) {
      if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error("INVALID_TARGET");
    }
    const local = (await workspaceStore.readWorkspaceState()).workspaces.find((w) => w.id === workspaceId);
    if (local?.workspaceType === "remote") throw new Error("REMOTE_TERMINAL_UNSUPPORTED");
    const response = await client.getJson("/workspaces");
    const workspace = response.items?.find((w) => w.id === workspaceId);
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
    if (workspace.workspaceType === "remote" || workspace.remoteType) throw new Error("REMOTE_TERMINAL_UNSUPPORTED");
    const { item: session } = await client.getJson(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`);
    if (session?.id !== sessionId) throw new Error("SESSION_NOT_FOUND");
    const directory = session.directory;
    const root = workspace.path ?? workspace.directory;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || typeof root !== "string" || !path.isAbsolute(root)) throw new Error("TARGET_STALE");
    const canonical = async (value) => {
      let resolved;
      try { resolved = await realpath(value); } catch { throw new Error("CWD_NOT_FOUND"); }
      if (!(await stat(resolved)).isDirectory()) throw new Error("CWD_NOT_DIRECTORY");
      return resolved;
    };
    const initialCwd = await canonical(directory);
    // The current session GET is not an ownership proof for sibling worktrees.
    // Fail closed until the runtime exposes explicit worktree membership.
    if (initialCwd !== await canonical(root)) throw new Error("SESSION_WORKSPACE_MISMATCH");
    if (local && await canonical(local.path) !== initialCwd) throw new Error("TARGET_STALE");
    return { workspaceId, sessionId, executionKind: "local", environmentId: "local", initialCwd, bindingRevision: initialCwd };
  };
}
