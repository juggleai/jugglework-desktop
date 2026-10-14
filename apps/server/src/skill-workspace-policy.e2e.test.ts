import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerTrustedOpencodeProcess, startServer } from "./server.js";
import { readSkillWorkspacePolicy, resetSkillWorkspacePolicyCacheForTests } from "./skill-workspace-policy.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  resetSkillWorkspacePolicyCacheForTests();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function harness(managed = true) {
  const root = await mkdtemp(join(tmpdir(), "jwork-skill-policy-"));
  roots.push(root);
  const second = join(root, "second");
  await mkdir(second);
  await mkdir(join(root, ".opencode", "skills", "demo"), { recursive: true });
  await writeFile(join(root, ".opencode", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Example\n---\nBody\n");
  const requests: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    if (new URL(request.url).pathname === "/skill") return Response.json([
      { name: "demo", description: "Example", location: "demo/SKILL.md" },
      { name: "other", description: "Other", location: "other/SKILL.md" },
    ]);
    return Response.json([]);
  } });
  stops.push(() => upstream.stop());
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "skill-client", hostToken: "skill-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "First", path: root, baseUrl: `http://127.0.0.1:${upstream.port}`, preset: "starter", workspaceType: "local" },
      { id: "ws_2", name: "Second", path: second, baseUrl: `http://127.0.0.1:${upstream.port}`, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const processState = { alive: true };
  if (managed) registerTrustedOpencodeProcess(config, {
    baseUrl: `http://127.0.0.1:${upstream.port}`, identity: "test-managed-engine", isAlive: () => processState.alive,
  });
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config, requests, processState };
}

const headers = { authorization: "Bearer skill-client", "content-type": "application/json" };

describe("workspace skill policy", () => {
  test("persists per workspace, exposes disabled skills for re-enabling, and checks live calls", async () => {
    const { base, config } = await harness();
    const policy = await fetch(`${base}/workspace/ws_1/skill-policy`, { headers });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ enforcementReady: true, disabledSkillNames: [], revision: 0 });
    const put = await fetch(`${base}/workspace/ws_1/skill-policy`, {
      method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: ["demo", "demo"] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ disabledSkillNames: ["demo"], revision: 1, enforcementReady: true });
    resetSkillWorkspacePolicyCacheForTests();
    expect((await readSkillWorkspacePolicy(config, "ws_1")).disabledSkillNames).toEqual(["demo"]);
    expect((await readSkillWorkspacePolicy(config, "ws_2")).disabledSkillNames).toEqual([]);
    const catalog = async (id: string) => {
      const response = await fetch(`${base}/w/${id}/opencode/skill`, { headers });
      expect(response.status).toBe(200);
      return response.json() as Promise<Array<{ name: string }>>;
    };
    expect((await catalog("ws_1")).map((skill) => skill.name)).toEqual(["other"]);
    expect((await catalog("ws_2")).map((skill) => skill.name)).toEqual(["demo", "other"]);
    const listed = await fetch(`${base}/workspace/ws_1/skills`, { headers });
    expect(await listed.json()).toMatchObject({ items: [expect.objectContaining({ name: "demo", enabled: false })] });
    const check = (directory: string) => fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST", headers, body: JSON.stringify({ directory, operation: "skill", args: { name: "demo" } }),
    }).then((response) => response.json());
    expect(await check(roots[0]!)).toMatchObject({ allowed: false, code: "skill_disabled_in_workspace" });
    expect(await check(join(roots[0]!, "second"))).toMatchObject({ allowed: true });
    await fetch(`${base}/workspace/ws_1/skill-policy`, { method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: [] }) });
    expect(await check(roots[0]!)).toMatchObject({ allowed: true });
    expect((await catalog("ws_1")).map((skill) => skill.name)).toEqual(["demo", "other"]);
  });

  test("unmanaged engines cannot advertise or change skill enforcement", async () => {
    const { base, config, requests } = await harness(false);
    const before = await readSkillWorkspacePolicy(config, "ws_1");
    const get = await fetch(`${base}/workspace/ws_1/skill-policy`, { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ enforcementReady: false, disabledSkillNames: [], revision: 0 });
    requests.length = 0;
    const put = await fetch(`${base}/workspace/ws_1/skill-policy`, {
      method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: ["demo"] }),
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ code: "skill_policy_unavailable" });
    resetSkillWorkspacePolicyCacheForTests();
    expect(await readSkillWorkspacePolicy(config, "ws_1")).toEqual(before);
    expect(requests).toEqual([]);
  });

  test.each(["dead", "different endpoint"])("rechecks managed trust for existing skill policies (%s)", async (reason) => {
    const { base, config, processState } = await harness();
    const url = `${base}/workspace/ws_1/skill-policy`;
    const initial = await fetch(url, {
      method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: ["demo"] }),
    });
    expect(initial.status).toBe(200);
    const before = await readSkillWorkspacePolicy(config, "ws_1");
    if (reason === "dead") processState.alive = false;
    else config.workspaces[0]!.baseUrl = "http://127.0.0.1:1";
    const get = await fetch(url, { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ enforcementReady: false, disabledSkillNames: ["demo"], revision: 1 });
    const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: [] }) });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ code: "skill_policy_unavailable" });
    resetSkillWorkspacePolicyCacheForTests();
    expect(await readSkillWorkspacePolicy(config, "ws_1")).toEqual(before);
  });

  test("rejects invalid policy and unmapped execution directory", async () => {
    const { base } = await harness();
    const invalid = await fetch(`${base}/workspace/ws_1/skill-policy`, {
      method: "PUT", headers, body: JSON.stringify({ disabledSkillNames: [123] }),
    });
    expect(invalid.status).toBe(400);
    const unmapped = await fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST", headers,
      body: JSON.stringify({ directory: `${roots[0]}-elsewhere`, workspaceId: "ws_1", operation: "skill", args: { name: "demo" } }),
    });
    expect(unmapped.status).toBe(404);
  });
});
