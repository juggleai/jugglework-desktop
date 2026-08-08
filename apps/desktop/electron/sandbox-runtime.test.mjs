import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  SANDBOX_CONTAINER_PREFIX,
  assertManagedSandboxContainerName,
  buildSandboxDockerRunCommand,
  createSandboxRuntime,
  deriveSandboxContainerName,
  normalizeSandboxBackend,
  parseSandboxMountSpec,
  resolveSandboxMounts,
} from "./sandbox-runtime.mjs";

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-sandbox-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function okResult(stdout = "") {
  return { program: "docker", status: 0, stdout, stderr: "" };
}

describe("sandbox request validation", () => {
  it("normalizes supported Desktop Docker backends and rejects other modes", () => {
    assert.equal(normalizeSandboxBackend(" Docker "), "docker");
    assert.equal(normalizeSandboxBackend("microsandbox"), "microsandbox");
    assert.throws(() => normalizeSandboxBackend("none"), /docker, microsandbox/);
    assert.throws(() => normalizeSandboxBackend("container"), /docker, microsandbox/);
  });

  it("constructs and validates only Desktop-managed container names", () => {
    assert.equal(deriveSandboxContainerName("run/id with spaces"), `${SANDBOX_CONTAINER_PREFIX}run-id-with-spaces`);
    assert.equal(assertManagedSandboxContainerName(`${SANDBOX_CONTAINER_PREFIX}run-1`), `${SANDBOX_CONTAINER_PREFIX}run-1`);
    assert.throws(() => assertManagedSandboxContainerName("jugglework-orchestrator-run-1"), /Refusing to manage/);
    assert.throws(() => assertManagedSandboxContainerName("unmanaged"), /Refusing to manage/);
  });

  it("parses ro/rw modes and rejects traversal or unknown modes", () => {
    assert.deepEqual(parseSandboxMountSpec("/tmp/project:src:ro"), {
      hostPath: "/tmp/project",
      containerSubPath: "src",
      requestedReadWrite: false,
    });
    assert.deepEqual(parseSandboxMountSpec("/tmp/project:src:rw"), {
      hostPath: "/tmp/project",
      containerSubPath: "src",
      requestedReadWrite: true,
    });
    assert.throws(() => parseSandboxMountSpec("/tmp/project:../secret:ro"), /normalized relative path/);
    assert.throws(() => parseSandboxMountSpec("/tmp/project:src:write"), /Use ro or rw/);
  });
});

describe("sandbox mount allowlist", () => {
  it("normalizes through realpath and downgrades rw when the allowed root is read-only", async () => {
    await withTempDir(async (root) => {
      const allowed = path.join(root, "allowed");
      const project = path.join(allowed, "project");
      await mkdir(project, { recursive: true });
      const mounts = await resolveSandboxMounts([`${project}:project:rw`], {
        allowlist: { allowedRoots: [{ path: allowed, allowReadWrite: false }], blockedPatterns: [] },
      });
      assert.deepEqual(mounts, [{ hostPath: await realpath(project), containerPath: "/workspace/extra/project", readonly: true }]);
    });
  });

  it("preserves explicitly allowed read-write access", async () => {
    await withTempDir(async (root) => {
      const allowed = path.join(root, "allowed");
      await mkdir(allowed, { recursive: true });
      const mounts = await resolveSandboxMounts([`${allowed}:source:rw`], {
        allowlist: { allowedRoots: [{ path: allowed, allowReadWrite: true }], blockedPatterns: [] },
      });
      assert.equal(mounts[0].readonly, false);
    });
  });

  it("rejects paths outside allowed roots and sensitive credential paths", async () => {
    await withTempDir(async (root) => {
      const allowed = path.join(root, "allowed");
      const outside = path.join(root, "outside");
      const ssh = path.join(allowed, ".ssh");
      await mkdir(outside, { recursive: true });
      await mkdir(ssh, { recursive: true });
      const allowlist = { allowedRoots: [{ path: allowed, allowReadWrite: true }] };
      await assert.rejects(resolveSandboxMounts([`${outside}:outside:ro`], { allowlist }), /not under any allowed root/);
      await assert.rejects(resolveSandboxMounts([`${ssh}:ssh:ro`], { allowlist }), /blocked pattern.*\.ssh/);
    });
  });

  it("cannot replace the default sensitive-path blocklist", async () => {
    await withTempDir(async (root) => {
      const ssh = path.join(root, ".ssh");
      await mkdir(ssh, { recursive: true });
      await assert.rejects(
        resolveSandboxMounts([`${ssh}:ssh:ro`], {
          allowlist: { allowedRoots: [{ path: root, allowReadWrite: true }], blockedPatterns: [] },
        }),
        /blocked pattern.*\.ssh/,
      );
    });
  });

  it("fails closed when extra mounts are requested without a readable allowlist", async () => {
    await withTempDir(async (root) => {
      const project = path.join(root, "project");
      await mkdir(project, { recursive: true });
      await assert.rejects(
        resolveSandboxMounts([`${project}:project:ro`], { allowlistPath: path.join(root, "missing.json") }),
        /Additional sandbox mounts are blocked/,
      );
    });
  });
});

describe("sandbox command construction", () => {
  it("runs Server directly with managed OpenCode and no orchestrator command", () => {
    const args = buildSandboxDockerRunCommand({
      backend: "docker",
      containerName: `${SANDBOX_CONTAINER_PREFIX}run-1`,
      extraMounts: [{ hostPath: "/allowed", containerPath: "/workspace/extra/src", readonly: true }],
      hostToken: "host-secret",
      image: "jugglework-microsandbox:dev",
      persistDir: "/persist",
      port: 43210,
      readOnly: false,
      token: "client-secret",
      workspacePath: "/workspace-host",
    });
    assert.deepEqual(args.slice(0, 6), ["run", "-d", "--name", `${SANDBOX_CONTAINER_PREFIX}run-1`, "-p", "127.0.0.1:43210:8787"]);
    assert.ok(args.includes("JUGGLEWORK_MANAGE_OPENCODE=1"));
    assert.ok(args.includes("JUGGLEWORK_OPENCODE_BIN=/usr/local/bin/opencode"));
    assert.ok(args.includes("/usr/local/bin/jugglework-server"));
    assert.ok(args.includes("jugglework-microsandbox:dev"));
    assert.ok(!args.some((arg) => arg.includes("orchestrator")));
    assert.ok(!args.includes("host-secret"));
    assert.ok(!args.includes("client-secret"));
    assert.ok(args.includes("/allowed:/workspace/extra/src:ro"));
  });
});

describe("sandbox lifecycle", () => {
  it("starts a detached managed container and reports connection details", async () => {
    await withTempDir(async (root) => {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const calls = [];
      const runtime = createSandboxRuntime({
        userDataDir: root,
        allocatePort: async () => 43123,
        probeHttp: async (url) => calls.push(["probe", url]),
        fetchImpl: async () => ({ ok: true, json: async () => ({ token: "owner" }) }),
        runDocker(args, timeoutMs, env) {
          calls.push(["docker", args, timeoutMs, env]);
          return okResult("container-id\n");
        },
      });
      const result = await runtime.start({ workspacePath: workspace, sandboxBackend: "docker", runId: "run-1" });
      assert.equal(result.juggleworkUrl, "http://127.0.0.1:43123");
      assert.equal(result.ownerToken, "owner");
      assert.equal(result.sandboxContainerName, `${SANDBOX_CONTAINER_PREFIX}run-1`);
      assert.ok(calls[0][1].includes("/usr/local/bin/jugglework-server"));
      assert.equal(calls[0][3].JUGGLEWORK_TOKEN, result.token);
      assert.deepEqual(calls[1], ["probe", "http://127.0.0.1:43123/health"]);
    });
  });

  it("rejects an unmanaged stop without invoking Docker", async () => {
    let calls = 0;
    const runtime = createSandboxRuntime({ runDocker: () => { calls += 1; return okResult(); } });
    await assert.rejects(runtime.stop("customer-container"), /Refusing to manage/);
    assert.equal(calls, 0);
  });

  it("collects diagnostics and removes the container when the health probe fails", async () => {
    await withTempDir(async (root) => {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const commands = [];
      const runtime = createSandboxRuntime({
        userDataDir: root,
        allocatePort: async () => 43124,
        probeHttp: async () => { throw new Error("health timeout"); },
        runDocker(args) {
          commands.push(args);
          if (args[0] === "inspect") return okResult("inspect-json");
          if (args[0] === "logs") return okResult("server-log");
          return okResult("container-id");
        },
      });
      await assert.rejects(
        runtime.start({ workspacePath: workspace, sandboxBackend: "docker", runId: "failed-probe" }),
        (error) => {
          const sandboxError = /** @type {Error & { sandboxDiagnostics: { dockerInspect: { stdout: string }, dockerLogs: { stdout: string } } }} */ (error);
          assert.match(sandboxError.message, /health timeout/);
          assert.equal(sandboxError.sandboxDiagnostics.dockerInspect.stdout, "inspect-json");
          assert.equal(sandboxError.sandboxDiagnostics.dockerLogs.stdout, "server-log");
          return true;
        },
      );
      assert.deepEqual(commands.map((args) => args[0]), ["run", "inspect", "logs", "rm"]);
      assert.deepEqual(commands.at(-1), ["rm", "-f", `${SANDBOX_CONTAINER_PREFIX}failed-probe`]);
    });
  });

  it("cleanup lists and removes only the Desktop managed namespace", async () => {
    const commands = [];
    const runtime = createSandboxRuntime({
      runDocker(args) {
        commands.push(args);
        if (args[0] === "ps") return okResult(`${SANDBOX_CONTAINER_PREFIX}one\nunmanaged\n${SANDBOX_CONTAINER_PREFIX}two\n`);
        return okResult();
      },
    });
    const result = await runtime.cleanup();
    assert.deepEqual(result.candidates, [`${SANDBOX_CONTAINER_PREFIX}one`, `${SANDBOX_CONTAINER_PREFIX}two`]);
    assert.deepEqual(result.removed, result.candidates);
    assert.deepEqual(commands[0], ["ps", "-a", "--filter", `name=^/${SANDBOX_CONTAINER_PREFIX}`, "--format", "{{.Names}}"]);
  });
});
