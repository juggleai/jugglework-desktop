import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workspaceRouteSource = readFileSync(
  new URL("../src/react-app/shell/workspace-app-route.tsx", import.meta.url),
  "utf8",
);
const sessionRouteSource = readFileSync(
  new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
  "utf8",
);

describe("workspace shell actions", () => {
  test("forwards retained session actions through the shared provider", () => {
    expect(workspaceRouteSource).toContain("<WorkspaceShellActionsProvider>");
    expect(workspaceRouteSource).toContain("workspaceShellActions.openTaskSearch");
    expect(workspaceRouteSource).toContain("workspaceShellActions.openCreateWorkspace");
    expect(sessionRouteSource).toContain("useRegisterWorkspaceShellActions(workspaceShellActions)");
  });

  test("does not navigate and click retained session DOM controls", () => {
    expect(workspaceRouteSource).not.toContain("openRetainedSessionAction");
    expect(workspaceRouteSource).not.toContain("querySelector");
    expect(workspaceRouteSource).not.toContain("requestAnimationFrame");
  });
});
