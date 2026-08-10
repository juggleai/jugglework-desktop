import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  RemoteControlCommandJournalError,
  createRemoteControlCommandJournal,
} from "./remote-control-command-journal.mjs";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

/** @typedef {NonNullable<Parameters<typeof createRemoteControlCommandJournal>[0]>} JournalOptions */
/** @typedef {ReturnType<typeof createRemoteControlCommandJournal>} Journal */
/** @typedef {{ commandId: string, deviceId: string, idempotencyKey: string | null, payloadHash: string, operation: string, createdAt: string, expiresAt: string }} JournalCommand */
/** @typedef {{ status: string, occurredAt: string, result: unknown, error: unknown }} JournalLifecycle */

/** @param {JournalOptions} [options] @returns {Promise<{ filePath: string, journal: Journal }>} */
async function isolatedJournal(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-command-journal-"));
  const filePath = path.join(root, "commands.json");
  return {
    filePath,
    journal: createRemoteControlCommandJournal({ filePath, now: () => NOW, ...options }),
  };
}

/** @param {Partial<JournalCommand>} [overrides] @returns {JournalCommand} */
function command(overrides = {}) {
  return {
    commandId: "command-1",
    deviceId: "device-1",
    idempotencyKey: "idempotency-1",
    payloadHash: "a".repeat(64),
    operation: "session.prompt",
    createdAt: "2026-08-09T11:59:00.000Z",
    expiresAt: "2026-08-09T12:05:00.000Z",
    ...overrides,
  };
}

/** @param {Partial<JournalLifecycle>} [overrides] @returns {JournalLifecycle} */
function successLifecycle(overrides = {}) {
  return {
    status: "succeeded",
    occurredAt: "2026-08-09T12:00:01.000Z",
    result: {
      operation: "session.prompt",
      payloadVersion: 1,
      result: { runId: "run-1", generation: 1 },
    },
    error: null,
    ...overrides,
  };
}

/** @param {Partial<JournalLifecycle>} [overrides] @returns {JournalLifecycle} */
function failureLifecycle(overrides = {}) {
  return {
    status: "failed",
    occurredAt: "2026-08-09T12:00:01.000Z",
    result: null,
    error: {
      schemaVersion: 1,
      code: "internal_error",
      message: "The remote operation failed.",
      retryable: false,
      correlationId: "command-1",
    },
    ...overrides,
  };
}

describe("remote-control command journal", () => {
  it("persists dispatching before execution and replays the exact terminal lifecycle after restart", async () => {
    const { filePath, journal } = await isolatedJournal();
    assert.deepEqual(await journal.prepare(command()), { action: "execute", commandId: "command-1" });

    const beforeComplete = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(beforeComplete.schemaVersion, 1);
    assert.equal(beforeComplete.entries[0].state, "dispatching");
    assert.equal(beforeComplete.entries[0].lifecycle, null);

    const lifecycle = successLifecycle();
    assert.deepEqual(await journal.complete("command-1", lifecycle), {
      action: "recorded",
      commandId: "command-1",
      lifecycle,
    });

    const restarted = createRemoteControlCommandJournal({ filePath, now: () => NOW });
    assert.deepEqual(await restarted.prepare(command({ commandId: "command-redelivery" })), {
      action: "replay",
      commandId: "command-1",
      lifecycle,
    });
  });

  it("replays the exact original error lifecycle", async () => {
    const { journal } = await isolatedJournal();
    await journal.prepare(command());
    const lifecycle = failureLifecycle();
    await journal.complete("command-1", lifecycle);

    assert.deepEqual(await journal.prepare(command({ commandId: "command-2" })), {
      action: "replay",
      commandId: "command-1",
      lifecycle,
    });
  });

  it("never blindly reexecutes a persisted indeterminate mutation after restart", async () => {
    const { filePath, journal } = await isolatedJournal();
    await journal.prepare(command());

    const restarted = createRemoteControlCommandJournal({ filePath, now: () => NOW });
    assert.deepEqual(await restarted.prepare(command({ commandId: "command-redelivery" })), {
      action: "reject",
      commandId: "command-1",
      error: {
        code: "delivery_failed",
        message: "The command outcome is indeterminate; execution was not repeated.",
        retryable: false,
      },
    });
  });

  it("persists and replays session.create as an idempotent mutation", async () => {
    const { filePath, journal } = await isolatedJournal();
    const create = command({ operation: "session.create" });
    assert.deepEqual(await journal.prepare(create), { action: "execute", commandId: "command-1" });
    const lifecycle = successLifecycle({
      result: { operation: "session.create", payloadVersion: 1, result: { sessionId: "ses_created" } },
    });
    await journal.complete("command-1", lifecycle);
    const restarted = createRemoteControlCommandJournal({ filePath, now: () => NOW });
    assert.deepEqual(await restarted.prepare({ ...create, commandId: "command-redelivery" }), {
      action: "replay",
      commandId: "command-1",
      lifecycle,
    });
    assert.equal((await restarted.prepare({ ...create, commandId: "command-no-key", idempotencyKey: null })).action, "reject");
  });

  it("keys idempotent mutations by device and key and conflicts on a different supplied hash", async () => {
    const { journal } = await isolatedJournal();
    await journal.prepare(command());

    assert.equal(
      (await journal.prepare(command({ commandId: "command-2", payloadHash: "b".repeat(64) }))).action,
      "reject",
    );
    const conflict = await journal.prepare(command({ commandId: "command-2", payloadHash: "b".repeat(64) }));
    assert.equal(
      conflict.action === "reject" ? conflict.error.code : null,
      "idempotency_conflict",
    );
    assert.deepEqual(
      await journal.prepare(command({
        commandId: "command-3",
        deviceId: "device-2",
      })),
      { action: "execute", commandId: "command-3" },
    );
  });

  it("validates only the supplied lowercase SHA-256 hash and does not derive a payload hash", async () => {
    const { journal } = await isolatedJournal();

    const uppercase = await journal.prepare(command({ payloadHash: "A".repeat(64) }));
    const short = await journal.prepare(command({ payloadHash: "a".repeat(63) }));
    assert.equal(uppercase.action === "reject" ? uppercase.error.code : null, "invalid_request");
    assert.equal(short.action === "reject" ? short.error.code : null, "invalid_request");
    assert.deepEqual(await journal.prepare(command({ payloadHash: "0".repeat(64) })), {
      action: "execute",
      commandId: "command-1",
    });
  });

  it("serializes concurrent prepare calls without losing entries", async () => {
    const { journal } = await isolatedJournal();
    const results = await Promise.all([
      journal.prepare(command({ commandId: "command-1", idempotencyKey: "key-1" })),
      journal.prepare(command({ commandId: "command-2", idempotencyKey: "key-2", payloadHash: "b".repeat(64) })),
      journal.prepare(command({ commandId: "command-3", idempotencyKey: "key-3", payloadHash: "c".repeat(64) })),
    ]);

    assert.deepEqual(results.map((result) => result.action), ["execute", "execute", "execute"]);
    assert.equal((await journal.inspect()).entries.length, 3);
  });

  it("uses temp-file replacement and removes a failed temp write", async () => {
    /** @type {Array<[string, string, string?]>} */
    const calls = [];
    /** @type {NonNullable<JournalOptions["fileSystem"]>} */
    const fileSystem = {
      async readFile(_filePath, _encoding) {
        const error = new Error("missing");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      },
      async mkdir(_directory, _options) {},
      async writeFile(filePath, _data, _options) {
        calls.push(["write", filePath]);
        throw new Error("disk unavailable");
      },
      async rename(from, to) {
        calls.push(["rename", from, to]);
      },
      async rm(filePath, _options) {
        calls.push(["rm", filePath]);
      },
    };
    const journal = createRemoteControlCommandJournal({
      filePath: "/virtual/commands.json",
      now: () => NOW,
      randomBytes: () => Buffer.alloc(6, 1),
      fileSystem,
    });

    await assert.rejects(journal.prepare(command()), (error) => {
      assert.ok(error instanceof RemoteControlCommandJournalError);
      assert.equal(error.code, "journal_unavailable");
      assert.doesNotMatch(error.message, /disk/);
      return true;
    });
    assert.match(calls[0][1], /commands\.json\.\d+\.010101010101\.tmp$/);
    assert.deepEqual(calls.map(([name]) => name), ["write", "rm"]);
  });

  it("cleans expired entries during load and explicitly", async () => {
    const { filePath, journal } = await isolatedJournal();
    await journal.prepare(command({
      commandId: "expired-later",
      idempotencyKey: "expired-later",
      expiresAt: "2026-08-09T12:00:01.000Z",
    }));

    const later = createRemoteControlCommandJournal({ filePath, now: () => NOW + 2_000 });
    assert.equal((await later.inspect()).entries.length, 0);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).entries.length, 0);

    let clock = NOW;
    const second = createRemoteControlCommandJournal({
      filePath: `${filePath}.second`,
      now: () => clock,
    });
    await second.prepare(command({ expiresAt: "2026-08-09T12:00:01.000Z" }));
    clock += 2_000;
    assert.equal(await second.cleanupExpired(), 1);
  });

  it("cleans entries that expire after the journal has already loaded", async () => {
    let clock = NOW;
    const { journal } = await isolatedJournal({ now: () => clock });
    await journal.prepare(command({ expiresAt: "2026-08-09T12:00:01.000Z" }));
    clock += 2_000;

    assert.deepEqual(
      await journal.prepare(command({
        commandId: "command-2",
        expiresAt: "2026-08-09T12:05:00.000Z",
      })),
      { action: "execute", commandId: "command-2" },
    );
    assert.deepEqual((await journal.inspect()).entries.map((entry) => entry.commandId), ["command-2"]);
  });

  it("fails closed on corrupt and future-version files without replacing them", async () => {
    for (const [name, raw, code] of [
      ["corrupt", "not json", "journal_corrupt"],
      ["future", JSON.stringify({ schemaVersion: 2, entries: [] }), "journal_version_unsupported"],
    ]) {
      const { filePath } = await isolatedJournal();
      await writeFile(filePath, raw, "utf8");
      const journal = createRemoteControlCommandJournal({ filePath, now: () => NOW });

      await assert.rejects(journal.prepare(command()), (error) => {
        assert.ok(error instanceof RemoteControlCommandJournalError);
        assert.equal(error.code, code);
        return true;
      });
      assert.equal(await readFile(filePath, "utf8"), raw, name);
    }
  });

  it("enforces bounded entries, file, and result sizes", async () => {
    const entryLimited = await isolatedJournal({ limits: { maxEntries: 1 } });
    await entryLimited.journal.prepare(command());
    await assert.rejects(
      entryLimited.journal.prepare(command({
        commandId: "command-2",
        idempotencyKey: "key-2",
        payloadHash: "b".repeat(64),
      })),
      (error) => error instanceof RemoteControlCommandJournalError && error.code === "journal_full",
    );

    const resultLimited = await isolatedJournal({ limits: { maxResultBytes: 16 } });
    await resultLimited.journal.prepare(command());
    await assert.rejects(
      resultLimited.journal.complete("command-1", successLifecycle()),
      (error) => error instanceof RemoteControlCommandJournalError && error.code === "invalid_request",
    );

    const fileLimited = await isolatedJournal({ limits: { maxFileBytes: 100 } });
    await assert.rejects(
      fileLimited.journal.prepare(command()),
      (error) => error instanceof RemoteControlCommandJournalError && error.code === "journal_full",
    );
  });

  it("refuses credentials in persisted result or error data", async () => {
    const { journal } = await isolatedJournal();
    await journal.prepare(command());

    await assert.rejects(
      journal.complete("command-1", successLifecycle({
        result: { operation: "session.prompt", token: "credential" },
      })),
      (error) => error instanceof RemoteControlCommandJournalError && error.code === "invalid_request",
    );
    await assert.rejects(
      journal.complete("command-1", failureLifecycle({
        error: { code: "internal_error", credentials: { password: "credential" } },
      })),
      (error) => error instanceof RemoteControlCommandJournalError && error.code === "invalid_request",
    );
  });
});
