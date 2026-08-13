import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startClaudeInternalToolsServer } from "./claude-internal-tools-server.js";
import { AgentRuntimeRepository } from "./agent-runtime-persistence/repository.js";
import { openRuntimeSqliteDatabase, runtimeSqliteAdapter } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude internal tool Server reauthorization", () => {
  test("reauthorizes credential, workspace, session, actor, schema, revision, and side effect per call", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-claude-tools-"));
    roots.push(root);
    await mkdir(join(root, ".opencode", "skills", "fixture"), { recursive: true });
    await writeFile(join(root, ".opencode", "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: Fixture guidance\n---\n\nUse fixtures.\n");
    await writeFile(join(root, "fixture.txt"), "needle on line one\n");
    const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(runtime));
    const updatedAt = 1_000;
    repository.createSession({
      id: "session-a",
      workspaceId: "workspace-a",
      runtimeId: "claude-agent",
      backendSessionId: null,
      title: "Claude",
      canonicalCwd: root,
      status: { type: "idle" },
      configuration: {},
      createdAt: updatedAt,
      updatedAt,
      lastError: null,
    });
    const aborted: unknown[] = [];
    const controlPlane = {
      snapshot: async () => ({ ok: "snapshot" }),
      abortRun: async (input: unknown) => { aborted.push(input); return { accepted: true }; },
    };
    const server = await startClaudeInternalToolsServer({
      config: config(root),
      repository,
      controlPlane: controlPlane as never,
      now: () => 500,
    });
    const call = async (overrides: Record<string, unknown> = {}, credential = server.credential) => {
      const body = {
        schemaVersion: 1,
        workspaceId: "workspace-a",
        sessionId: "session-a",
        actor: "claude-worker",
        tool: "context",
        sideEffect: "read",
        expectedRevision: 0,
        args: { expectedRevision: 0 },
        ...overrides,
      };
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-jugglework-claude-tool-credential": credential },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() as Record<string, unknown> };
    };
    try {
      const context = await call();
      expect(context.response.status).toBe(200);
      const result = context.body.result as { revision: number };
      expect(result.revision).toBe(updatedAt);

      for (const invalid of [
        [{ workspaceId: "workspace-b" }],
        [{ sessionId: "session-b" }],
        [{ actor: "renderer" }],
        [{ schemaVersion: 2 }],
        [{ tool: "execute", sideEffect: "read", expectedRevision: updatedAt, args: { expectedRevision: updatedAt, id: "session.abort", args: { runId: "run-a" } } }],
        [{ expectedRevision: 1, args: { expectedRevision: 1 } }],
      ] as Array<[Record<string, unknown>]>) {
        expect((await call(invalid[0])).response.status).toBe(403);
      }
      expect((await call({}, "b".repeat(43))).response.status).toBe(403);

      const search = await call({
        tool: "search",
        expectedRevision: updatedAt,
        args: { expectedRevision: updatedAt, pattern: "needle", include: "*.txt" },
      });
      expect(search.response.status).toBe(200);
      expect(JSON.stringify(search.body)).toContain("fixture.txt");

      const literalSearch = await call({
        tool: "search",
        expectedRevision: updatedAt,
        args: { expectedRevision: updatedAt, pattern: "needle.*one", include: "*.txt" },
      });
      expect(literalSearch.response.status).toBe(200);
      expect(JSON.stringify(literalSearch.body)).not.toContain("fixture.txt");

      const skill = await call({ tool: "skill", expectedRevision: updatedAt, args: { expectedRevision: updatedAt, name: "fixture" } });
      expect(skill.response.status).toBe(200);
      expect(JSON.stringify(skill.body)).toContain("Use fixtures");

      const execute = await call({
        tool: "execute",
        sideEffect: "write",
        expectedRevision: updatedAt,
        args: { expectedRevision: updatedAt, id: "session.abort", args: { runId: "run-a" } },
      });
      expect(execute.response.status).toBe(200);
      expect(aborted).toHaveLength(1);
    } finally {
      await server.stop();
      repository.close();
    }
  });

  test("rejects artifact outbox symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-claude-tools-"));
    const outside = await mkdtemp(join(tmpdir(), "jugglework-claude-tools-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, ".opencode", "jugglework"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside-secret");
    await symlink(outside, join(root, ".opencode", "jugglework", "outbox"), "dir");
    const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(runtime));
    repository.createSession({
      id: "session-a",
      workspaceId: "workspace-a",
      runtimeId: "claude-agent",
      backendSessionId: null,
      title: "Claude",
      canonicalCwd: root,
      status: { type: "idle" },
      configuration: {},
      createdAt: 1_000,
      updatedAt: 1_000,
      lastError: null,
    });
    const server = await startClaudeInternalToolsServer({
      config: config(root),
      repository,
      controlPlane: {} as never,
      now: () => 500,
    });
    const artifactCall = (operation: "read" | "write", content?: string) => fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jugglework-claude-tool-credential": server.credential },
      body: JSON.stringify({
        schemaVersion: 1,
        workspaceId: "workspace-a",
        sessionId: "session-a",
        actor: "claude-worker",
        tool: "artifact",
        sideEffect: operation === "write" ? "write" : "read",
        expectedRevision: 1_000,
        args: { expectedRevision: 1_000, operation, path: "secret.txt", ...(content === undefined ? {} : { content }) },
      }),
    });
    try {
      expect((await artifactCall("read")).status).toBe(403);
      expect((await artifactCall("write", "overwritten")).status).toBe(403);
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside-secret");
    } finally {
      await server.stop();
      repository.close();
    }
  });

  test("renews expired internal tool credentials without reviving old leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-claude-tools-"));
    roots.push(root);
    const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
    const repository = AgentRuntimeRepository.fromDatabase(runtimeSqliteAdapter(runtime));
    repository.createSession({
      id: "session-a",
      workspaceId: "workspace-a",
      runtimeId: "claude-agent",
      backendSessionId: null,
      title: "Claude",
      canonicalCwd: root,
      status: { type: "idle" },
      configuration: {},
      createdAt: 1_000,
      updatedAt: 1_000,
      lastError: null,
    });
    let currentTime = 500;
    const server = await startClaudeInternalToolsServer({
      config: config(root),
      repository,
      controlPlane: {} as never,
      now: () => currentTime,
    });
    const call = (credential: string) => fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jugglework-claude-tool-credential": credential },
      body: JSON.stringify({
        schemaVersion: 1,
        workspaceId: "workspace-a",
        sessionId: "session-a",
        actor: "claude-worker",
        tool: "context",
        sideEffect: "read",
        expectedRevision: 0,
        args: { expectedRevision: 0 },
      }),
    });
    try {
      expect((await call(server.credential)).status).toBe(200);
      currentTime = server.credentialExpiresAt + 1;
      const renewed = server.leaseCredential();
      expect(renewed.credential).not.toBe(server.credential);
      expect((await call(server.credential)).status).toBe(403);
      expect((await call(renewed.credential)).status).toBe(200);
    } finally {
      await server.stop();
      repository.close();
    }
  });
});

function config(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client",
    hostToken: "host",
    configPath: join(root, "server.json"),
    approval: { mode: "manual", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [{ id: "workspace-a", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: 0,
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}
