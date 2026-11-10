import assert from "node:assert/strict";
import test from "node:test";

import { createOfficeCloudDocsCoordinator } from "./office-cloud-docs-coordinator.mjs";

const binding = {
  paragraphId: "a1b2c3d4",
  blockId: "block-1",
};

function fixture() {
  const states = [];
  const calls = [];
  let wordEvent;
  let nativeEvent;
  const coordinator = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud(_documentId, callback) {
        wordEvent = callback;
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision: 0,
              blocks: [
                {
                  id: binding.paragraphId,
                  text: "hello",
                  kind: "text",
                  marks: [
                    { index: 0, length: 5, bold: false, italic: false },
                  ],
                },
              ],
            }),
            apply: async () => ({ status: "applied", revision: 0 }),
            structure: async () => ({ status: "applied", revision: 0 }),
          },
          async close() {
            calls.push("office.close");
          },
        };
      },
    },
    editors: {
      async open() {
        return {
          async call(type) {
            calls.push(type);
            if (type === "editor.project") return { status: "awaiting-word" };
            return { status: "attached" };
          },
          close() {
            calls.push("editor.close");
          },
        };
      },
      dispose() {
        calls.push("editors.dispose");
      },
    },
    onState(attachmentId, state) {
      states.push({ attachmentId, ...state });
    },
  });
  nativeEvent = (message) =>
    coordinator.handleNativeEvent(
      "11111111-1111-4111-8111-111111111111",
      message,
    );
  return {
    coordinator,
    states,
    calls,
    wordEvent: (message) => wordEvent(message),
    nativeEvent,
  };
}

test("正式协调器建立单一 Word 与 AFFiNE 关联并可显式释放", async () => {
  const value = fixture();
  const result = await value.coordinator.link({
    attachmentId: "11111111-1111-4111-8111-111111111111",
    documentId: "office-doc-1",
    pageId: "page_1",
    bindings: [binding],
  });
  assert.equal(result.status, "active");
  assert.equal(
    value.coordinator.state(result.attachmentId).documentId,
    "office-doc-1",
  );
  assert.ok(value.calls.includes("editor.attach"));
  assert.equal(value.coordinator.documentState("office-doc-1").status, "active");
  assert.equal(value.coordinator.documentState("different-document").status, "detached");

  value.nativeEvent({ type: "editor.pending", payload: {} });
  value.wordEvent({
    type: "word.changed",
    payload: { source: "word", frames: [], revision: 1 },
  });
  await value.coordinator.unlink(result.attachmentId);
  assert.deepEqual(
    value.calls.filter((item) => item.endsWith(".close")),
    ["editor.close", "office.close"],
  );
  assert.equal(value.coordinator.state(result.attachmentId).status, "detached");
  assert.equal(value.coordinator.documentState("office-doc-1").status, "detached");
});

test("Office 模型关闭后按文档释放后台编辑器并保留暂停关联", async () => {
  const states = [];
  const coordinator = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud() {
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision: 0,
              blocks: [{ id: binding.paragraphId, text: "hello", kind: "text", marks: [] }],
            }),
            apply: async () => ({ status: "applied", revision: 0 }),
            structure: async () => ({ status: "applied", revision: 0 }),
          },
          async close() {},
        };
      },
    },
    editors: {
      async open() {
        return {
          context: { workspaceId: "native-workspace" },
          async call(type) {
            if (type === "editor.attach")
              return { status: "attached", bindings: [binding] };
            if (type === "editor.project")
              return { status: "awaiting-word" };
            return { status: "attached" };
          },
          close() {},
        };
      },
      dispose() {},
    },
    bindingsStore: {
      async upsert() {},
      async setState(attachmentId, state, reason) {
        states.push({ attachmentId, state, reason });
      },
    },
    onState() {},
  });
  await coordinator.link({
    attachmentId: "11111111-1111-4111-8111-111111111111",
    documentId: "office-doc-1",
    pageId: "page_1",
    bindings: [binding],
  });
  await coordinator.unlinkDocument("office-doc-1");
  assert.equal(
    coordinator.state("11111111-1111-4111-8111-111111111111").status,
    "detached",
  );
  assert.deepEqual(states.at(-1), {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    state: "paused",
    reason: "word_closed",
  });
});

test("组织撤权只释放同来源账号和租户的 Word 关联", async () => {
  const value = fixture();
  const base = {
    sourceServerOrigin: "https://server.example",
    sourceUserId: "user-1",
    tenantId: "tenant-a",
    pageId: "page_1",
    bindings: [binding],
  };
  await value.coordinator.link({
    ...base,
    attachmentId: "11111111-1111-4111-8111-111111111111",
    documentId: "office-doc-1",
  });
  await value.coordinator.link({
    ...base,
    tenantId: "tenant-b",
    attachmentId: "22222222-2222-4222-8222-222222222222",
    documentId: "office-doc-2",
  });
  const result = await value.coordinator.unlinkScope(base);
  assert.equal(result.count, 1);
  assert.equal(
    value.coordinator.state("11111111-1111-4111-8111-111111111111").status,
    "detached",
  );
  assert.equal(
    value.coordinator.state("22222222-2222-4222-8222-222222222222").status,
    "active",
  );
});

test("组织撤权即使一份状态持久化失败也释放全部关联", async () => {
  const base = {
    sourceServerOrigin: "https://server.example",
    sourceUserId: "user-1",
    tenantId: "tenant-a",
    pageId: "page_1",
    bindings: [binding],
  };
  const failing = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud() {
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision: 0,
              blocks: [{ id: binding.paragraphId, text: "hello", kind: "text", marks: [] }],
            }),
            apply: async () => ({ status: "applied", revision: 0 }),
            structure: async () => ({ status: "applied", revision: 0 }),
          },
          async close() {},
        };
      },
    },
    editors: {
      async open() {
        return {
          context: { workspaceId: "native-workspace" },
          async call(type) {
            if (type === "editor.attach")
              return { status: "attached", bindings: [binding] };
            if (type === "editor.project") return { status: "awaiting-word" };
            return { status: "attached" };
          },
          close() {},
        };
      },
      dispose() {},
    },
    bindingsStore: {
      async upsert() {},
      async setState() {
        throw new Error("disk_unavailable");
      },
    },
    onState() {},
  });
  for (const [attachmentId, documentId] of [
    ["33333333-3333-4333-8333-333333333333", "office-doc-3"],
    ["44444444-4444-4444-8444-444444444444", "office-doc-4"],
  ])
    await failing.link({ ...base, attachmentId, documentId });
  await assert.rejects(failing.unlinkScope(base), /disk_unavailable/);
  assert.equal(
    failing.state("33333333-3333-4333-8333-333333333333").status,
    "detached",
  );
  assert.equal(
    failing.state("44444444-4444-4444-8444-444444444444").status,
    "detached",
  );
});

test("对象映射缺失时拒绝进入 linked", async () => {
  const value = fixture();
  await assert.rejects(
    value.coordinator.link({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      documentId: "office-doc-1",
      pageId: "page_1",
      bindings: [],
    }),
    /invalid_word_cloud_binding/,
  );
});

test("首次关联先写入 AFFiNE 原生 DOCX 附件再建立 Word 映射", async () => {
  const calls = [];
  const coordinator = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud() {
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision: 0,
              blocks: [{ id: binding.paragraphId, text: "hello", kind: "text", marks: [] }],
            }),
            apply: async () => ({ status: "applied", revision: 0 }),
            structure: async () => ({ status: "applied", revision: 0 }),
          },
          async close() {},
        };
      },
    },
    editors: {
      async open() {
        return {
          context: { workspaceId: "native-workspace" },
          async call(type) {
            calls.push(type);
            if (type === "editor.original") return { status: "applied" };
            if (type === "editor.attach")
              return { status: "attached", bindings: [binding] };
            if (type === "editor.project")
              return { status: "awaiting-word" };
            return { status: "attached" };
          },
          close() {},
        };
      },
      dispose() {},
    },
    bindingsStore: { async upsert() {}, async setState() {} },
    onState() {},
  });
  await coordinator.link({
    attachmentId: "11111111-1111-4111-8111-111111111111",
    documentId: "office-doc-1",
    pageId: "page_1",
    bindings: [binding],
    original: {
      sourceId: "a".repeat(64),
      name: "source.docx",
      size: 4,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  assert.ok(calls.indexOf("editor.original") < calls.indexOf("editor.attach"));
});

test("Office 保存前后双方未变化才推进共同检查点", async () => {
  let revision = 0;
  const committed = [];
  const coordinator = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud() {
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision,
              blocks: [
                {
                  id: binding.paragraphId,
                  text: "hello",
                  kind: "text",
                  marks: [
                    { index: 0, length: 5, bold: false, italic: false },
                  ],
                },
              ],
            }),
            apply: async () => ({ status: "applied", revision }),
            structure: async () => ({ status: "applied", revision }),
          },
          async close() {},
        };
      },
    },
    editors: {
      async open() {
        return {
          context: { workspaceId: "native-workspace" },
          async call(type) {
            if (type === "editor.attach")
              return { status: "attached", bindings: [binding] };
            if (type === "editor.project")
              return { status: "prepared", token: 1, frames: [] };
            if (type === "editor.checkpoint")
              return {
                status: "prepared",
                nativeSchemaVersion: 1,
                nativeStateVector: "dmVjdG9y",
                nativeSnapshot: "c25hcHNob3Q=",
                bindings: [binding],
                mappingCheckpoint: { schemaVersion: 1, records: [] },
              };
            return { status: "attached" };
          },
          close() {},
        };
      },
      dispose() {},
    },
    bindingsStore: {
      async upsert() {},
      async setState() {},
      async commitCheckpoint(input) {
        committed.push(input);
        return { checkpointId: "checkpoint-1" };
      },
    },
    onState() {},
  });
  await coordinator.link({
    attachmentId: "11111111-1111-4111-8111-111111111111",
    documentId: "office-doc-1",
    pageId: "page_1",
    tenantId: "tenant-1",
    bindings: [binding],
  });
  assert.deepEqual(
    await coordinator.prepareCheckpoint({
      documentId: "office-doc-1",
      pageId: "office-page-1",
    }),
    { status: "active", modelSynchronized: true },
  );
  const confirmed = await coordinator.confirmSaved({
    documentId: "office-doc-1",
    pageId: "office-page-1",
    savedAt: 42,
    savedFileSha256: "a".repeat(64),
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].localSavedFileSha256, "a".repeat(64));

  await coordinator.prepareCheckpoint({
    documentId: "office-doc-1",
    pageId: "office-page-1",
  });
  revision = 1;
  assert.equal(
    (
      await coordinator.confirmSaved({
        documentId: "office-doc-1",
        pageId: "office-page-1",
        savedAt: 43,
        savedFileSha256: "b".repeat(64),
      })
    ).status,
    "skipped",
  );
  assert.equal(committed.length, 1);
});

test("重开文件重新打包后由原生恢复核对共同内容，而非仅以文件摘要拒绝", async () => {
  const calls = [];
  const persisted = {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    sourceServerOrigin: "http://127.0.0.1:18020",
    sourceUserId: "user-1",
    tenantId: "tenant-1",
    docsWorkspaceId: "native-workspace",
    pageId: "page_1",
    localWorkspaceId: "local-workspace",
    relativePath: "docs/spec.docx",
    bindings: [binding],
    checkpoint: { localSavedFileSha256: "a".repeat(64) },
  };
  const coordinator = createOfficeCloudDocsCoordinator({
    officePanel: {
      async attachWordCloud() {
        return {
          word: {
            snapshot: async () => ({
              status: "active",
              revision: 0,
              blocks: [
                {
                  id: binding.paragraphId,
                  text: "hello",
                  kind: "text",
                  marks: [
                    { index: 0, length: 5, bold: false, italic: false },
                  ],
                },
              ],
            }),
            apply: async () => ({ status: "applied", revision: 0 }),
            structure: async () => ({ status: "applied", revision: 0 }),
          },
          async close() {},
        };
      },
    },
    editors: {
      async open() {
        return {
          context: { workspaceId: "native-workspace" },
          async call(type) {
            calls.push(type);
            if (type === "editor.restore")
              return { status: "attached", baselineValidated: true, bindings: [binding] };
            if (type === "editor.project")
              return { status: "prepared", token: 1, frames: [] };
            return { status: "attached" };
          },
          close() {},
        };
      },
      dispose() {},
    },
    bindingsStore: {
      async loadRecovery() {
        return {
          binding: persisted,
          recoveryCheckpoint: {
            nativeSnapshot: "c25hcHNob3Q=",
            nativeStateVector: "dmVjdG9y",
            mappingCheckpoint: { schemaVersion: 1, records: [] },
          },
        };
      },
      async upsert() {},
      async setState() {},
    },
    onState() {},
  });
  const result = await coordinator.recover({
    ...persisted,
    document: {
      documentId: "new-office-document",
      workspaceId: persisted.localWorkspaceId,
      relativePath: persisted.relativePath,
      state: "ready",
      engineFileId: "new-model",
      savedFileSha256: "b".repeat(64),
    },
  });
  assert.equal(result.status, "active");
  assert.ok(calls.includes("editor.restore"));
  assert.ok(!calls.includes("editor.attach"));
});
