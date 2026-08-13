import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("staged rollout rehearsal emits reproducible rollback evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "jugglework-rollout-evidence-"));
  try {
    execFileSync(process.execPath, ["scripts/release/rehearse-claude-rollout.mjs", `--output=${join(directory, "evidence.json")}`], {
      cwd: root,
      encoding: "utf8",
    });
    const evidence = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
    assert.equal(evidence.passed, true);
    assert.equal(evidence.externalReleasePublished, false);
    assert.deepEqual(evidence.verification.map(({ id, passed }) => [id, passed]), [
      ["shared-rollout-contract", true],
      ["server-opencode-only-and-advanced-rollback", true],
      ["worker-run-per-query-rollback", true],
    ]);
    assert.deepEqual(evidence.scenarios.map(({ id, passed }) => [id, passed]), [
      ["opencode-only-default", true],
      ["internal-ineligible", true],
      ["internal-cohort", true],
      ["opt-in-declined", true],
      ["opt-in-accepted", true],
      ["ga", true],
      ["ga-kill-switch-rollback", true],
      ["invalid-stage-fail-closed", true],
    ]);
    assert.ok(evidence.rollback.advanced.length >= 13);
    assert.ok(evidence.rollback.advanced.every(({ configured, result }) => configured && result === "baseline-run-per-query"));
    assert.equal(evidence.rollback.claudeRuntimeKillSwitch, "opencode-only");
    assert.match(evidence.contentSha256WithoutDigest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
