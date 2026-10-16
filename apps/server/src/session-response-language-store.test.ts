import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase } from "./runtime-db.js";
import { SessionResponseLanguageStore } from "./session-response-language-store.js";

test("session response language uses UI locale only as the initial fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-response-language-"));
  const path = join(root, "runtime.sqlite");
  try {
    const store = SessionResponseLanguageStore.fromDatabase(
      automationSqliteAdapter(await openRuntimeSqliteDatabase(path)),
    );
    try {
      assert.equal(store.resolveAndWrite({ workspaceId: "ws", sessionId: "ses", fallback: "zh" }), "zh");
      assert.equal(store.resolveAndWrite({ workspaceId: "ws", sessionId: "ses", fallback: "en" }), "zh");
      const failedMutation = store.apply({ workspaceId: "ws", sessionId: "ses", detected: "en", fallback: "en" });
      assert.equal(store.read("ws", "ses"), "en");
      store.rollback(failedMutation);
      assert.equal(store.read("ws", "ses"), "zh");
      assert.equal(store.resolveAndWrite({ workspaceId: "ws", sessionId: "ses", detected: "en", fallback: "zh" }), "en");
      assert.equal(store.resolveAndWrite({ workspaceId: "ws", sessionId: "ses", fallback: "zh" }), "en");
      assert.equal(store.read("ws", "ses"), "en");
      store.copy("ws", "ses", "ses_fork");
      assert.equal(store.read("ws", "ses_fork"), "en");
    } finally {
      store.close();
    }
    const reopened = SessionResponseLanguageStore.fromDatabase(
      automationSqliteAdapter(await openRuntimeSqliteDatabase(path)),
    );
    try {
      assert.equal(reopened.read("ws", "ses"), "en");
      reopened.delete("ws", "ses");
      assert.equal(reopened.read("ws", "ses"), null);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
