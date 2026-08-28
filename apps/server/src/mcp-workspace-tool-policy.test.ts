import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyMcpWorkspacePolicyToPrompt,
  checkMcpWorkspaceToolPolicy,
  readMcpWorkspaceToolPolicy,
  resetMcpWorkspaceToolPolicyCacheForTests,
  resolveMcpServerNameFromToolId,
  writeMcpWorkspaceToolPolicy,
} from "./mcp-workspace-tool-policy.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  resetMcpWorkspaceToolPolicyCacheForTests();
  delete process.env.JUGGLEWORK_RUNTIME_DB;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "jwork-mcp-policy-"));
  roots.push(root);
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return { configPath: join(root, "config.json") } as ServerConfig;
}

describe("workspace MCP tool policy", () => {
  test("defaults enabled and persists only disabled server names", async () => {
    const serverConfig = await config();
    expect((await readMcpWorkspaceToolPolicy(serverConfig, "ws_1")).disabledServerNames).toEqual([]);
    const written = await writeMcpWorkspaceToolPolicy(serverConfig, "ws_1", ["linear", "github", "linear"]);
    expect(written.disabledServerNames).toEqual(["github", "linear"]);
    expect(written.revision).toBe(1);
    expect((await readMcpWorkspaceToolPolicy(serverConfig, "ws_1")).disabledServerNames).toEqual(["github", "linear"]);
  });

  test("resolves sanitized names with the longest prefix", () => {
    expect(resolveMcpServerNameFromToolId("salesforce_prod_query", ["salesforce", "salesforce.prod"])).toBe("salesforce.prod");
    expect(resolveMcpServerNameFromToolId("github_search_issues", ["github"])).toBe("github");
  });

  test("sanitized namespace collisions fail closed", () => {
    expect(resolveMcpServerNameFromToolId("salesforce_prod_query", ["salesforce.prod", "salesforce prod"]))
      .toBeTruthy();
  });

  test("filters next-turn catalog without re-enabling caller-denied tools", () => {
    const prompt = applyMcpWorkspacePolicyToPrompt(
      { parts: [], tools: { question: false, github_search: true } },
      ["github_search", "linear_create", "read"],
      ["github"],
    );
    expect(prompt.tools).toMatchObject({ question: false, github_search: false });
    expect((prompt.tools as Record<string, boolean>).read).toBeUndefined();
  });

  test("blocks stale MCP calls and generic resource access", () => {
    expect(checkMcpWorkspaceToolPolicy({ toolId: "github_search", serverNames: ["github"], disabledServerNames: ["github"] })).toMatchObject({
      allowed: false,
      serverName: "github",
      code: "mcp_disabled_in_workspace",
    });
    expect(checkMcpWorkspaceToolPolicy({
      toolId: "read_mcp_resource",
      args: { server: "github", uri: "repo://1" },
      disabledServerNames: ["github"],
    }).allowed).toBe(false);
    expect(checkMcpWorkspaceToolPolicy({
      toolId: "list_mcp_resources",
      args: {},
      disabledServerNames: ["github"],
    }).code).toBe("mcp_resource_server_required");
  });

  test("does not hide generic resource tools from the prompt catalog", () => {
    const prompt = applyMcpWorkspacePolicyToPrompt(
      { parts: [] },
      ["list_mcp_resources", "read_mcp_resource", "github_search"],
      ["github"],
    );
    expect((prompt.tools as Record<string, boolean>).github_search).toBe(false);
    expect((prompt.tools as Record<string, boolean>).list_mcp_resources).toBeUndefined();
    expect((prompt.tools as Record<string, boolean>).read_mcp_resource).toBeUndefined();
  });
});
