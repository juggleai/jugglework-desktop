import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

test("GET /skills/detail is matched before /skills/:name and returns the exact global skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-skill-detail-route-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const configDir = join(root, "opencode-config");
  const globalSkillDir = join(configDir, "skills", "same-name");
  const projectSkillDir = join(workspace, ".opencode", "skills", "same-name");
  await mkdir(globalSkillDir, { recursive: true });
  await mkdir(projectSkillDir, { recursive: true });
  await writeFile(join(globalSkillDir, "SKILL.md"), "---\nname: same-name\ndescription: Global\n---\nGlobal body\n");
  await writeFile(join(globalSkillDir, "notes.txt"), "notes");
  await writeFile(join(projectSkillDir, "SKILL.md"), "---\nname: same-name\ndescription: Project\n---\nProject body\n");
  process.env.OPENCODE_CONFIG_DIR = configDir;

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "skill-client",
    hostToken: "skill-host",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());

  const query = new URLSearchParams({ scope: "global", path: join(globalSkillDir, "SKILL.md") });
  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/detail?${query}`, {
    headers: { authorization: "Bearer skill-client" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    item: { name: "same-name", scope: "global", description: "Global" },
    content: expect.stringContaining("Global body"),
    files: [
      { relPath: "SKILL.md", size: expect.any(Number) },
      { relPath: "notes.txt", size: 5 },
    ],
  });
});
