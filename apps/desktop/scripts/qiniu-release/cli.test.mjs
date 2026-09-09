import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, runCli } from "./cli.mjs";

const REQUIRED = [
  "--version", "1.2.15",
  "--channel", "stable",
  "--platform", "mac",
  "--arch", "arm64,x64",
  "--dist", "/tmp/dist",
  "--evidence", "/tmp/evidence.json",
];

test("CLI strictly parses release coordinates and dry-run", () => {
  const parsed = parseArguments(["plan", ...REQUIRED, "--dry-run", "--pre-canary-exception-reason", "Operator authorized the live upgrade validation"]);
  assert.equal(parsed.options.dryRun, true);
  assert.deepEqual(parsed.options.architectures, ["arm64", "x64"]);
  assert.equal(parsed.options.preCanaryExceptionReason, "Operator authorized the live upgrade validation");
});

test("SemVer prereleases are alpha-only and targets stay restricted", () => {
  assert.equal(parseArguments(["plan", ...REQUIRED.with(1, "1.2.16-alpha.1").with(3, "alpha")]).options.version, "1.2.16-alpha.1");
  assert.throws(() => parseArguments(["plan", ...REQUIRED.with(1, "1.2.16-alpha.1")]), /Invalid stable version/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED.with(1, "1.2.16+build.1").with(3, "alpha")]), /Invalid release version/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED.with(3, "beta")]), /Unsupported channel/);
});

test("CLI rejects missing inputs, unknown subcommands, and unaudited recovery", () => {
  assert.throws(() => parseArguments(["publish", ...REQUIRED]), /Unknown command/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED.slice(0, -2)]), /Missing required --evidence/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED, "--unknown", "value"]), /Unknown option/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED.with(5, "windows")]), /Unsupported release platform/);
  assert.throws(() => parseArguments(["plan", ...REQUIRED.with(7, "ia32")]), /Unsupported architecture/);
  assert.throws(() => parseArguments(["recover-lock", ...REQUIRED, "--reason", "publisher terminated"]), /requires --audit/);
});

test("build executes caller argv without shell while dry-run never executes", async () => {
  const calls = [];
  const execute = async (argv) => { calls.push(argv); return { status: 0 }; };
  const output = () => {};
  const command = ["node", "script with spaces.mjs", "value;not-shell"];
  await runCli(["build", ...REQUIRED, "--", ...command], { execute, output });
  await runCli(["build", ...REQUIRED, "--dry-run", "--", ...command], { execute, output });
  assert.deepEqual(calls, [command]);
  assert.throws(() => parseArguments(["build", ...REQUIRED]), /requires a command argv/);
});

test("recover-lock routes authorized and completed records to the required audit artifact", async () => {
  const lock = { size: 4, etag: "etag", putTime: "123" };
  let present = true;
  const qiniu = {
    async stat() { return present ? lock : null; },
    async delete() { present = false; },
  };
  const records = [];
  await runCli([
    "recover-lock", ...REQUIRED, "--reason", "publisher confirmed terminated", "--actor", "operator", "--audit", "/secure/audit.jsonl",
  ], {
    qiniu,
    output: () => {},
    appendAudit: async (filePath, record) => records.push({ filePath, record }),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });
  assert.deepEqual(records.map(({ filePath, record }) => [filePath, record.status]), [
    ["/secure/audit.jsonl", "authorized"],
    ["/secure/audit.jsonl", "completed"],
  ]);
});
