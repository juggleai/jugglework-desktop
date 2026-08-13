import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { projectCodexCapabilities } from "./codex-capability-config.mjs";

async function skill(root, name, body) {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), body);
}

describe("Codex capability projection", () => {
  it("copies bundled and workspace skills but never user-global Codex skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-caps-"));
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "profile");
    const bundled = path.join(root, "bundled");
    await skill(bundled, "built-in", "# built in");
    await skill(path.join(workspace, ".opencode", "skills"), "project", "# project");
    await skill(path.join(root, "global-codex", "skills"), "private", "# private");
    await mkdir(home, { recursive: true });
    const result = await projectCodexCapabilities({ codexHome: home, workspaceRoot: workspace, bundledSkillsDir: bundled });
    assert.deepEqual(result.skills.map((item) => [item.id, item.source]), [["built-in", "bundled"], ["project", "workspace"]]);
    assert.equal(await readFile(path.join(home, ".agents", "skills", "built-in", "SKILL.md"), "utf8"), "# built in");
    await assert.rejects(readFile(path.join(home, ".agents", "skills", "private", "SKILL.md")));
  });

  it("projects MCP configuration while keeping credentials in process env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-"));
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "profile");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({ mcp: {
      local: { command: ["node", "server.mjs"], environment: { API_KEY: "secret" } },
      remote: { url: "https://mcp.example.test", headers: { Authorization: "Bearer token" } },
    } }));
    const result = await projectCodexCapabilities({ codexHome: home, workspaceRoot: workspace });
    assert.equal(result.mcpCount, 2);
    assert.match(result.configToml, /\[mcp_servers\.local\]/);
    assert.doesNotMatch(result.configToml, /secret|Bearer token/);
    assert.equal(result.env.API_KEY, "secret");
    assert.equal(Object.values(result.env).includes("Bearer token"), true);
  });
});
