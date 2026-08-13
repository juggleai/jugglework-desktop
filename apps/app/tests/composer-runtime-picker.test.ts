import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const composer = readFileSync(fileURLToPath(new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url)), "utf8");
const route = readFileSync(fileURLToPath(new URL("../src/react-app/shell/session-route.tsx", import.meta.url)), "utf8");

describe("composer runtime picker", () => {
  test("reuses the agent control for OpenCode and Codex with a separate OpenCode profile section", () => {
    assert.match(composer, /\(\["opencode", "codex"\] as const\)\.map/);
    assert.match(composer, /t\("composer\.agent_profile_label"\)/);
    assert.match(composer, /props\.runtimeKind === "opencode"/);
  });

  test("exposes Codex only for local desktop workspaces and creates a new session when switching", () => {
    assert.match(route, /codexRuntimeAvailable: isDesktopRuntime\(\) && selectedWorkspace\?\.workspaceType !== "remote"/);
    assert.match(route, /setWorkspaceDraftRuntime\(selectedWorkspaceId, kind, workspaceType\)/);
    assert.match(route, /await handleCreateTaskInWorkspace\(selectedWorkspaceId\)/);
  });

  test("marks unavailable Codex as disabled for keyboard and assistive technology", () => {
    assert.match(composer, /disabled=\{disabled\}/);
    assert.match(composer, /aria-disabled=\{disabled\}/);
    assert.match(composer, /t\("composer\.runtime_codex_local_only"\)/);
  });
});
