import { expect, test } from "bun:test";
import { createEditor, $createParagraphNode, $createTextNode, $getRoot, $nodesOfType } from "lexical";
import { cloudDocReferences, cloudDocToken, mergeCloudDocReferences, parseCloudDocToken } from "../src/app/lib/cloud-doc-reference";
import { ComposerCloudDocNode, $insertCloudDocReference } from "../src/react-app/domains/session/surface/composer/cloud-doc-node";
import { COMPOSER_TOKEN_SPLIT_RE } from "../src/react-app/domains/session/surface/composer/capability-tags";
import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

const doc = { tenantId: "org-a", workspaceId: "workspace", docId: "doc", title: "方案 ] @测试 / A" };

/** 使用真实 Lexical 节点，验证光标插入、合并和删除后的实际发送引用。 */
function harness(text = "前文 @方案") {
  const editor = createEditor({ namespace: "cloud-doc-composer", nodes: [ComposerCloudDocNode], onError(error) { throw error; } });
  editor.update(() => { $getRoot().append($createParagraphNode().append($createTextNode(text))); $getRoot().selectEnd(); }, { discrete: true });
  const update = (fn: () => void) => editor.update(fn, { discrete: true });
  const draft = () => editor.getEditorState().read(() => $getRoot().getTextContent());
  return { editor, update, draft };
}

test("标题含空格、括号、@ 的引用可随草稿往返；正文和 hash 不接受为标签数据", () => {
  const token = cloudDocToken(doc);
  expect(parseCloudDocToken(token)).toEqual(doc);
  expect(`前${token}后`.split(COMPOSER_TOKEN_SPLIT_RE)).toEqual(["前", token, "后"]);
  expect(parseCloudDocToken(cloudDocToken({ ...doc, text: "正文" } as any))).toBeNull();
  expect(parseCloudDocToken("[cloud-doc invalid%]")).toBeNull();
});

test("选中的 @ 查询替换为单个标签，合并选区不损坏前后正文；删除后没有引用", () => {
  const h = harness();
  h.update(() => $insertCloudDocReference({ ...doc, blockIds: ["b1"] }, { mention: true }));
  expect(h.draft()).toStartWith("前文 [cloud-doc ");
  expect(h.draft()).not.toContain("@方案");
  h.update(() => $insertCloudDocReference({ ...doc, blockIds: ["b2", "b1"] }));
  expect(cloudDocReferences(h.draft())[0].blockIds).toEqual(["b1", "b2"]);
  h.update(() => $insertCloudDocReference(doc));
  expect(cloudDocReferences(h.draft())).toEqual([doc]);
  h.update(() => $nodesOfType(ComposerCloudDocNode)[0].remove());
  expect(h.draft()).toBe("前文  ");
  expect(cloudDocReferences(h.draft())).toEqual([]);
});

test("标签限制为 32 篇、200 个块；同名文档和其他组织保持独立定位", () => {
  const refs = Array.from({ length: 32 }, (_, i) => ({ ...doc, docId: String(i) }));
  expect(() => mergeCloudDocReferences(refs, doc)).toThrow("cloud_docs.reference_limit");
  expect(() => mergeCloudDocReferences([], { ...doc, blockIds: Array.from({ length: 201 }, (_, i) => String(i)) })).toThrow("cloud_docs.selection_limit");
  expect(mergeCloudDocReferences([doc], { ...doc, tenantId: "org-b" })).toHaveLength(2);
});

test("异步可读校验只替换仍在草稿中的链接，不重插已删除的链接", () => {
  const link = "https://docs.example/workspace/ws/doc";
  const h = harness(`前 ${link} 后`);
  h.update(() => $insertCloudDocReference(doc, { link }));
  expect(cloudDocReferences(h.draft())).toEqual([doc]);
  expect(h.draft()).toEndWith(" 后");
  const deleted = harness("链接已删");
  deleted.update(() => $insertCloudDocReference(doc, { link }));
  expect(deleted.draft()).toBe("链接已删");
});

test("标签经 Lexical 序列化恢复，选区保持原子节点", () => {
  const h = harness("要求 ");
  h.update(() => $insertCloudDocReference({ ...doc, blockIds: ["b1"] }));
  const saved = JSON.stringify(h.editor.getEditorState().toJSON());
  const restored = harness("");
  restored.editor.setEditorState(restored.editor.parseEditorState(saved));
  expect(cloudDocReferences(restored.draft())[0].blockIds).toEqual(["b1"]);
});

test("排队草稿的引用随真实发送内容保留，不读取后来会话的草稿", async () => {
  const token = cloudDocToken(doc);
  const draft = { mode: "prompt" as const, text: `请修改 ${token}`, resolvedText: `请修改 ${token}`, parts: [{ type: "text" as const, text: `请修改 ${token}` }], attachments: [] };
  const store = useComposerStateStore.getState();
  const queued = store.appendQueuedDraft("cloud-a", draft);
  store.setDraft("cloud-b", cloudDocToken({ ...doc, docId: "other" }));
  const parts = await draftToParts(queued.draft, "/tmp", "cloud-a", null);
  expect(cloudDocReferences(parts.filter(part => part.type === "text").map(part => part.text).join(""))).toEqual([doc]);
  store.clearQueuedDrafts("cloud-a");
  store.clearSession("cloud-b");
});
