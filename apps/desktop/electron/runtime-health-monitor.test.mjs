import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRuntimePressure,
  installRuntimeHealthMonitor,
  parsePsProcessMetrics,
  resolveOpencodeDatabasePath,
} from "./runtime-health-monitor.mjs";

const GIB = 1024 ** 3;

test("resolves an existing OpenCode database without changing its location", () => {
  const existing = "/Users/test/.local/share/opencode/opencode.db";
  assert.equal(resolveOpencodeDatabasePath({
    env: {},
    homedir: "/Users/test",
    platform: "darwin",
    fileExists: (candidate) => candidate === existing,
  }), existing);
  assert.equal(resolveOpencodeDatabasePath({
    env: { OPENCODE_DB: "/data/custom.db" },
    homedir: "/Users/test",
    platform: "darwin",
    fileExists: () => false,
  }), "/data/custom.db");
});

test("parses ps RSS in KiB and classifies combined database pressure", () => {
  assert.deepEqual(parsePsProcessMetrics("  8192  137.5\n"), {
    rssBytes: 8 * 1024 ** 2,
    cpuPercent: 137.5,
  });
  assert.equal(parsePsProcessMetrics("8192 1.2.3"), null);
  assert.equal(classifyRuntimePressure({ rssBytes: 512 * 1024 ** 2, databaseBytes: 4 * GIB }), "warning");
  assert.equal(classifyRuntimePressure({ rssBytes: 2.1 * GIB, databaseBytes: 3.1 * GIB }), "critical");
  assert.equal(classifyRuntimePressure({ rssBytes: 4.1 * GIB, databaseBytes: 0 }), "critical");
});

test("monitor reports bounded health data and exposes the latest sample", async () => {
  const records = [];
  let timerCallback = null;
  const monitor = installRuntimeHealthMonitor({
    runtimeManager: { engineInfo: async () => ({ pid: 42 }) },
    record: (event, data) => records.push({ event, data }),
    env: { OPENCODE_DB: "/tmp/opencode-test.db" },
    homedir: "/tmp",
    platform: "darwin",
    processSampler: async () => ({ rssBytes: 5 * GIB, cpuPercent: 140 }),
    statFile: async (candidate) => {
      if (candidate.endsWith("-wal")) return { size: 10 };
      if (candidate.endsWith("-shm")) throw new Error("missing");
      return { size: 20 };
    },
    now: () => 1_000,
    setIntervalFn: (callback) => {
      timerCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {},
  });
  const sample = await monitor.sampleNow();
  assert.equal(sample.pid, 42);
  assert.equal(sample.databaseBytes, 30);
  assert.equal(sample.pressure, "critical");
  assert.equal(records.at(-1).event, "runtime.health");
  assert.equal(records.at(-1).data.rssBytes, 5 * GIB);
  assert.equal("databasePath" in records.at(-1).data, false);
  assert.equal(typeof timerCallback, "function");
  monitor.dispose();
});

test("monitor coalesces samples and disposal prevents late records and further reads", async () => {
  let complete = (_metrics) => {};
  /** @type {Promise<{rssBytes: number, cpuPercent: number}>} */
  const pendingMetrics = new Promise((resolve) => { complete = resolve; });
  let calls = 0;
  let cleared = 0;
  const records = [];
  const monitor = installRuntimeHealthMonitor({
    runtimeManager: { engineInfo: async () => { calls++; return { pid: 42 }; } },
    processSampler: () => pendingMetrics,
    statFile: async () => ({ size: 0 }),
    env: { OPENCODE_DB: "/tmp/mock.db" }, homedir: "/tmp",
    record: (...args) => records.push(args),
    setIntervalFn: () => 1, clearIntervalFn: () => { cleared++; },
  });
  const first = monitor.sampleNow();
  assert.equal(first, monitor.sampleNow());
  await Promise.resolve();
  monitor.dispose();
  complete({ rssBytes: 5 * GIB, cpuPercent: 0 });
  assert.equal(await first, null);
  assert.equal(await monitor.sampleNow(), null);
  assert.equal(calls, 1);
  assert.equal(cleared, 1);
  assert.deepEqual(records, []);
});

test("sampler and engine failures are contained without lifecycle mutations or unhandled rejection", async () => {
  for (const failEngine of [false, true]) {
    const records = [];
    const monitor = installRuntimeHealthMonitor({
      runtimeManager: { engineInfo: async () => { if (failEngine) throw new Error("unavailable"); return { pid: 42 }; } },
      processSampler: async () => { throw new Error("ps unavailable"); },
      statFile: async () => { throw new Error("not found"); },
      env: { OPENCODE_DB: "/tmp/mock.db" }, homedir: "/tmp",
      record: (event, data) => records.push({ event, data }),
      setIntervalFn: () => 1, clearIntervalFn: () => {},
    });
    const sample = await monitor.sampleNow();
    assert.equal(sample.rssBytes, null);
    assert.equal(sample.pressure, "normal");
    assert.equal(records.length, 1);
    monitor.dispose();
  }
});
