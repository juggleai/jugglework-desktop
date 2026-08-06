import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandMatchesPackagedSidecar,
  denModelsCatalogUrl,
  embeddedServerImportUrl,
  prioritizeWorkspacePaths,
  resolveJuggleWorkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyJuggleWorkPortWorkspace,
  shouldReuseHealthyManagedRuntime,
  snapshotEngineState,
} from "./runtime.mjs";

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyJuggleWorkPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyJuggleWorkPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyJuggleWorkPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("shouldReuseHealthyManagedRuntime", () => {
  it("reuses one healthy managed engine when the selected workspace changes", () => {
    assert.equal(shouldReuseHealthyManagedRuntime({
      forceRestart: false,
      inProcess: true,
      lifecycleState: "healthy",
      remoteAccessEnabled: false,
      requestedRemoteAccess: false,
      running: true,
      baseUrl: "http://127.0.0.1:4097",
      hasToken: true,
    }), true);
  });

  it("does not reuse when a restart or remote-access change is required", () => {
    const healthy = {
      inProcess: true,
      lifecycleState: "healthy",
      remoteAccessEnabled: false,
      requestedRemoteAccess: false,
      running: true,
      baseUrl: "http://127.0.0.1:4097",
      hasToken: true,
    };
    assert.equal(shouldReuseHealthyManagedRuntime({ ...healthy, forceRestart: true }), false);
    assert.equal(shouldReuseHealthyManagedRuntime({ ...healthy, forceRestart: false, requestedRemoteAccess: true }), false);
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/JuggleWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/JuggleWork.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/JuggleWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("embeddedServerImportUrl", () => {
  it("returns the same file URL for unchanged metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jugglework-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");

      const first = embeddedServerImportUrl(embeddedPath);
      const second = embeddedServerImportUrl(embeddedPath);
      const url = new URL(first);

      assert.equal(first, second);
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url), embeddedPath);
      assert.ok(url.searchParams.get("mtimeMs"));
      assert.equal(url.searchParams.get("size"), String("export const value = 1;\n".length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when the file metadata changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jugglework-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");
      const first = embeddedServerImportUrl(embeddedPath);

      await writeFile(embeddedPath, "export const value = 12;\n");

      assert.notEqual(embeddedServerImportUrl(embeddedPath), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain file URL if stat fails", () => {
    const missingPath = path.join(os.tmpdir(), "jugglework-missing-embedded.js");

    assert.equal(embeddedServerImportUrl(missingPath), pathToFileURL(missingPath).href);
  });
});

describe("resolveJuggleWorkServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveJuggleWorkServerConfigPath({ JUGGLEWORK_SERVER_CONFIG: "/tmp/jugglework/server.json" }),
      "/tmp/jugglework/server.json",
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveJuggleWorkServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/jugglework/server.json",
    );
  });
});

describe("snapshotEngineState", () => {
  it("reports server-managed OpenCode liveness and pid without a child handle", () => {
    const snapshot = snapshotEngineState({
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: null,
      opencodePassword: null,
      opencodeBinPath: null,
      opencodeBinSource: null,
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: null,
      lastStderr: null,
      execution: null,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.managedByServer, true);
    assert.equal(snapshot.pid, 12345);
  });
});

describe("denModelsCatalogUrl", () => {
  it("points the engine at the connected deployment's catalog", () => {
    for (const baseUrl of [
      "https://juggle.example.test",
      "https://juggle.example.test/",
      "https://juggle.example.test/jwork",
      "https://juggle.example.test/jwork/api",
    ]) {
      assert.equal(denModelsCatalogUrl(baseUrl), "https://juggle.example.test/jwork/models");
    }
  });

  it("keeps a deployment mounted under a sub-path", () => {
    assert.equal(
      denModelsCatalogUrl("https://host.example/base/api/den"),
      "https://host.example/base/jwork/models",
    );
  });

  it("points the hosted engine at the hosted deployment catalog", () => {
    assert.equal(denModelsCatalogUrl("https://work.juggle.im"), "https://work.juggle.im/jwork/models");
    assert.equal(denModelsCatalogUrl("https://work.juggle.im/api/den"), "https://work.juggle.im/jwork/models");
  });

  it("returns null rather than a broken URL for unusable input", () => {
    for (const value of ["", "   ", "not a url", "ftp://host/path", null, undefined]) {
      assert.equal(denModelsCatalogUrl(value), null);
    }
  });
});
