import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createRemoteEventDiagnostics } from "./remote-event-diagnostics.mjs";

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

describe("remote event diagnostics", () => {
  it("writes only allowlisted content-free metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-event-diagnostics-"));
    roots.push(root);
    const consoleRecords = [];
    const logger = createRemoteEventDiagnostics({
      enabled: true,
      logsDirectory: root,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
      console: { debug: (...args) => consoleRecords.push(args), info() {}, warn() {}, error() {} },
    });
    logger.debug("remote_session_raw_received", {
      eventType: "message.part.updated",
      projectedCount: 1,
      workspaceId: "secret-workspace",
      token: "secret-token",
      body: "secret-content",
    });
    await logger.flush();

    const text = await readFile(logger.filePath, "utf8");
    assert.match(text, /remote_session_raw_received/);
    assert.match(text, /message\.part\.updated/);
    assert.doesNotMatch(text, /secret|workspaceId|token|body/);
    assert.equal(consoleRecords.length, 1);
  });

  it("does nothing unless explicitly enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-event-diagnostics-"));
    roots.push(root);
    const logger = createRemoteEventDiagnostics({ enabled: false, logsDirectory: root });
    logger.warn("remote_session_subscription_retry", { status: 401 });
    await logger.flush();
    await assert.rejects(readFile(logger.filePath, "utf8"), { code: "ENOENT" });
  });
});
