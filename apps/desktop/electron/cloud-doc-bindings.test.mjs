import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCloudDocBindingsStore } from "./cloud-doc-bindings.mjs";

const binding = {
  attachmentId: "89ad90ce-88ab-42bd-91e3-8e8d9b5acbea",
  documentId: "word-1",
  sourceServerOrigin: "http://127.0.0.1:18020",
  sourceUserId: "user-1",
  tenantId: "tenant-1",
  docsWorkspaceId: "workspace-1",
  pageId: "page-1",
  localWorkspaceId: "local-workspace",
  relativePath: "docs/spec.docx",
  bindings: [{ paragraphId: "1234abcd", blockId: "block-1" }],
  state: "active",
};

test("关联元数据原子保存且不包含正文和令牌", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jw-doc-bindings-"));
  try {
    const filePath = path.join(directory, "cloud-doc-bindings.json");
    const store = createCloudDocBindingsStore({ filePath });
    await store.upsert(binding);
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /launchGrant|bootstrapUrl|正文/);
    assert.equal(JSON.parse(raw).schemaVersion, 2);
    assert.deepEqual((await store.list())[0], {
      ...binding,
      mappingVersion: 1,
      checkpoint: null,
      updatedAt: JSON.parse(raw).bindings[0].updatedAt,
    });
    await store.pauseUnrestorableAfterRestart();
    assert.deepEqual((await store.list())[0], {
      ...binding,
      mappingVersion: 1,
      checkpoint: null,
      state: "paused",
      pauseReason: "restart_requires_common_checkpoint",
      updatedAt: (await store.list())[0].updatedAt,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("暂停和显式解除更新既有关联", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jw-doc-bindings-"));
  try {
    const store = createCloudDocBindingsStore({
      filePath: path.join(directory, "cloud-doc-bindings.json"),
    });
    await store.upsert({ ...binding, checkpoint: { revision: 3 } });
    await store.setState(binding.attachmentId, "paused", "word_closed");
    assert.equal((await store.list())[0].pauseReason, "word_closed");
    await store.setState(binding.attachmentId, "unlinked", "user_unlinked");
    assert.equal((await store.list())[0].state, "unlinked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("损坏或未知版本的关联文件不会被启动写入静默覆盖", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jw-doc-bindings-"));
  try {
    const filePath = path.join(directory, "cloud-doc-bindings.json");
    await writeFile(filePath, "{broken", { mode: 0o600 });
    const broken = createCloudDocBindingsStore({ filePath });
    await assert.rejects(
      broken.pauseUnrestorableAfterRestart(),
      SyntaxError,
    );
    assert.equal(await readFile(filePath, "utf8"), "{broken");

    const unsupported = '{"schemaVersion":99,"bindings":[]}\n';
    await writeFile(filePath, unsupported, { mode: 0o600 });
    const future = createCloudDocBindingsStore({ filePath });
    await assert.rejects(
      future.pauseUnrestorableAfterRestart(),
      /unsupported_cloud_doc_bindings_schema/,
    );
    assert.equal(await readFile(filePath, "utf8"), unsupported);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("共同检查点先写不可变资源再推进指针且只保留前一份", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jw-doc-bindings-"));
  try {
    const filePath = path.join(directory, "cloud-doc-bindings.json");
    const store = createCloudDocBindingsStore({ filePath });
    await store.upsert(binding);
    const snapshots = ["first", "second", "third"].map((value) =>
      Buffer.from(value).toString("base64"),
    );
    /** @type {any[]} */
    const checkpoints = [];
    for (const [index, snapshot] of snapshots.entries())
      checkpoints.push(
        await store.commitCheckpoint({
          attachmentId: binding.attachmentId,
          localSavedFileSha256: String(index + 1).repeat(64),
          nativeStateVector: Buffer.from(`vector-${index}`).toString("base64"),
          nativeSnapshot: snapshot,
          nativeSchemaVersion: 1,
          bindings: binding.bindings,
          mappingCheckpoint: { schemaVersion: 1, records: [] },
          confirmedAt: index + 1,
        }),
      );
    const current = (await store.list())[0].checkpoint;
    assert.ok(current);
    assert.ok(current.previous);
    assert.ok(checkpoints[0]);
    assert.ok(checkpoints[1]);
    assert.ok(checkpoints[2]);
    assert.equal(current.checkpointId, checkpoints[2].checkpointId);
    assert.equal(current.previous.checkpointId, checkpoints[1].checkpointId);
    assert.equal(current.previous.previous, undefined);
    await assert.rejects(
      access(
        path.join(
          directory,
          "cloud-doc-checkpoints",
          binding.attachmentId,
          checkpoints[0].checkpointId,
        ),
      ),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(path.join(directory, current.nativeSnapshotRef), "utf8"),
      "third",
    );
    await store.pauseUnrestorableAfterRestart();
    assert.equal((await store.list())[0].pauseReason, "restart_recovery_required");
    const recoverable = await store.findRecoverable({
      sourceServerOrigin: binding.sourceServerOrigin,
      sourceUserId: binding.sourceUserId,
      tenantId: binding.tenantId,
      localWorkspaceId: binding.localWorkspaceId,
      relativePath: binding.relativePath,
    });
    assert.ok(recoverable);
    assert.equal(recoverable.attachmentId, binding.attachmentId);
    const recovery = await store.loadRecovery({
      ...binding,
      attachmentId: binding.attachmentId,
    });
    assert.equal(recovery.recoveryCheckpoint.nativeSnapshot, snapshots[2]);
    assert.equal(
      recovery.recoveryCheckpoint.mappingCheckpoint.schemaVersion,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("移动文件只按唯一共同摘要显式重新定位", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jw-doc-bindings-"));
  try {
    const store = createCloudDocBindingsStore({
      filePath: path.join(directory, "cloud-doc-bindings.json"),
    });
    await store.upsert(binding);
    await store.commitCheckpoint({
      attachmentId: binding.attachmentId,
      localSavedFileSha256: "a".repeat(64),
      nativeStateVector: Buffer.from("vector").toString("base64"),
      nativeSnapshot: Buffer.from("snapshot").toString("base64"),
      nativeSchemaVersion: 1,
      bindings: binding.bindings,
      mappingCheckpoint: { schemaVersion: 1, records: [] },
      confirmedAt: 1,
    });
    await store.setState(binding.attachmentId, "paused", "word_closed");
    const identity = {
      sourceServerOrigin: binding.sourceServerOrigin,
      sourceUserId: binding.sourceUserId,
      tenantId: binding.tenantId,
      localWorkspaceId: binding.localWorkspaceId,
      relativePath: "archive/spec.docx",
      savedFileSha256: "a".repeat(64),
    };
    const candidate = await store.findRelocatable(identity);
    assert.equal(candidate?.attachmentId, binding.attachmentId);
    assert.equal(candidate?.previousRelativePath, binding.relativePath);
    assert.equal(
      await store.findRelocatable({
        ...identity,
        savedFileSha256: "b".repeat(64),
      }),
      null,
    );
    await store.upsert({
      ...binding,
      attachmentId: "a0b4a54a-82d4-45b5-b78f-9991f7f6111e",
      documentId: "word-existing",
      relativePath: identity.relativePath,
    });
    await assert.rejects(
      store.relocate({
        ...identity,
        attachmentId: binding.attachmentId,
        documentId: "word-moved",
      }),
      /word_relocation_conflict/,
    );
    await store.setState(
      "a0b4a54a-82d4-45b5-b78f-9991f7f6111e",
      "unlinked",
      "test_cleanup",
    );
    await store.relocate({
      ...identity,
      attachmentId: binding.attachmentId,
      documentId: "word-moved",
    });
    const moved = (await store.list())[0];
    assert.equal(moved.documentId, "word-moved");
    assert.equal(moved.relativePath, "archive/spec.docx");
    assert.equal(moved.pauseReason, "relocation_confirmed");
    assert.ok(
      await store.findRecoverable({
        ...identity,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
