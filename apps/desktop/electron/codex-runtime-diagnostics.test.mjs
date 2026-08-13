import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCodexDiagnostics } from "./codex-runtime-diagnostics.mjs";

describe("Codex runtime diagnostics", () => {
  it("classifies every healthy layer without exposing a workspace path", async () => {
    const checks = Object.fromEntries(["binary", "version", "handshake", "token", "gateway", "model", "sandbox", "workspace"].map((name) => [name, async () => name === "binary" ? { path: "/Users/private/work/codex" } : name === "version" ? { version: "0.147.0" } : {}]));
    const report = await runCodexDiagnostics({ checks });
    assert.equal(report.ok, true);
    assert.equal("executable" in report.checks[0] ? report.checks[0].executable : null, "codex");
    assert.equal(JSON.stringify(report).includes("/Users/private"), false);
  });

  it("redacts credentials, loopback nonces and paths from failures", async () => {
    const report = await runCodexDiagnostics({ checks: {
      binary: async () => ({}), version: async () => ({}), handshake: async () => ({}),
      token: async () => { const error = Object.assign(new Error("Authorization=Bearer abc at http://127.0.0.1:4999/private and /Users/me/project"), { code: "gateway_auth_expired" }); throw error; },
    } });
    const serialized = JSON.stringify(report);
    assert.equal(report.ok, false);
    assert.equal(serialized.includes("abc"), false);
    assert.equal(serialized.includes("private"), false);
    assert.equal(serialized.includes("/Users/me"), false);
  });
});
