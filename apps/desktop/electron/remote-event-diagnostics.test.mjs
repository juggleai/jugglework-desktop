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
  it("clock and disk failures remain best effort and lifecycle fields survive the allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-event-diagnostics-")); roots.push(root);
    let broken = true;
    const logger = createRemoteEventDiagnostics({ enabled: false, logsDirectory: root, console: {},
      now: () => { if (broken) throw new Error("clock"); return new Date(); } });
    assert.doesNotThrow(() => logger.info("remote_activity_journal_ack", {}));
    broken = false;
    logger.info("remote_activity_journal_lifecycle", { workspaceHash: "abc", pollerHash: "def", cursor: 12, count: 1, reason: "scheduled" });
    await logger.flush();
    const record = JSON.parse((await readFile(logger.filePath, "utf8")).trim());
    assert.equal(record.cursor, 12); assert.equal(record.pollerHash, "def"); assert.equal(record.reason, "scheduled");
    const disk = createRemoteEventDiagnostics({ enabled: false, logsDirectory: logger.filePath, console: {} });
    disk.warn("remote_activity_journal_retry", {}); await disk.flush();
    disk.info("remote_activity_journal_ack", {}); await disk.flush();
  });
  it("persists journal ACK diagnostics even when general debug logging is disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-event-diagnostics-"));
    roots.push(root);
    const logger = createRemoteEventDiagnostics({ enabled: false, logsDirectory: root, console: { info() {} } });
    logger.info("remote_activity_journal_ack", { runHash: "1234567890abcdef", generation: 860,
      status: "completed", reason: "persisted", accepted: true, prompt: "secret", token: "secret" });
    await logger.flush();
    const text = await readFile(logger.filePath, "utf8");
    assert.match(text, /"generation":860/);
    assert.match(text, /"reason":"persisted"/);
    assert.doesNotMatch(text, /secret|prompt|token/);
  });
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
      stage: "welcome",
      agentErrorCode: "transport_closed",
      closeCode: 1008,
      lifecycleGeneration: 12,
      connectionGeneration: 7,
      workspaceId: "secret-workspace",
      token: "secret-token",
      body: "secret-content",
    });
    await logger.flush();

    const text = await readFile(logger.filePath, "utf8");
    assert.match(text, /remote_session_raw_received/);
    assert.match(text, /message\.part\.updated/);
    assert.match(text, /"stage":"welcome"/);
    assert.match(text, /"closeCode":1008/);
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
