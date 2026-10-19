import { beforeEach, expect, test } from "bun:test";
import type { OfficeSelectionReference } from "@jugglework/types/office";
import type { ComposerDraft } from "../src/app/types";
import { getComposerOfficeGroups, releasableOfficeReferences, useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import { officeSubmissionFromDraft } from "../src/react-app/domains/session/surface/composer/office-selection-draft";

const ref: OfficeSelectionReference = { referenceId: "ref-a", captureId: "capture-a", workspaceId: "ws", ownerSessionId: "chat", documentId: "doc-a", modelGeneration: "page:model", sourcePageId: "page", locator: { kind: "sheet-cells", sheetId: "sheet-2", ranges: [{ startRow: 7, endRow: 7, startCol: 0, endCol: 0 }] }, contentStamp: "stamp", capturedAt: 1, preview: { name: "表.xlsx", path: "表.xlsx", range: "第二表!A8", text: "" } };
beforeEach(() => useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, officeEpochs: {}, officePendingSubmissions: {} }));
function append(reference = ref, instructionId = "i-a", text = "改为 10") {
  const state = useComposerStateStore.getState();
  state.appendOfficeSelection({ sessionId: "chat", reference, instructionId, text, epoch: state.officeEpochs.chat ?? 0, mode: "add" });
}
function draft(): ComposerDraft {
  const state = useComposerStateStore.getState();
  return { text: state.sessions.chat!.draft, resolvedText: "改为 10", mode: "prompt", attachments: [], parts: getComposerOfficeGroups(state, "chat").map((group) => ({ type: "office-selection", ...structuredClone(group) })) };
}
test("主动删除选区保留要求为普通文字，不显示重选状态、不携带执行引用或隐式绑定新选区", () => {
  append();
  const original = draft();
  const queued = useComposerStateStore.getState().appendQueuedDraft("chat", original);
  useComposerStateStore.getState().removeOfficeReference("chat", "i-a", "ref-a");
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")[0]).toEqual({ references: [], instruction: { instructionId: "i-a", text: "改为 10", bindingState: "detached", referenceIds: [] } });
  expect(officeSubmissionFromDraft(draft()).officeSelectionRefs).toEqual([]);
  expect(officeSubmissionFromDraft(queued.draft).officeSelectionRefs).toEqual(["ref-a"]);
  expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", ["ref-a"])).toEqual([]);
  append({ ...ref, referenceId: "ref-b", captureId: "capture-b", documentId: "doc-b" }, "i-b", "新要求");
  const groups = getComposerOfficeGroups(useComposerStateStore.getState(), "chat");
  expect(groups[0].instruction.bindingState).toBe("detached");
  expect(groups[1].instruction.referenceIds).toEqual(["ref-b"]);
});
test("系统清理选区保留对应要求并拒绝隐式改投，只有显式重新绑定才替换目标", () => {
  append();
  useComposerStateStore.getState().clearOfficeReferences("chat", 1, ["ref-a"]);
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")[0].instruction).toEqual({ instructionId: "i-a", text: "改为 10", bindingState: "needs-selection", referenceIds: [] });
  expect(() => officeSubmissionFromDraft(draft())).toThrow("重新选择");
  append({ ...ref, referenceId: "ref-b", captureId: "capture-b", documentId: "doc-b" }, "i-b", "新要求");
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")[0].instruction.bindingState).toBe("needs-selection");
  useComposerStateStore.getState().removeOfficeReference("chat", "i-b", "ref-b");
  useComposerStateStore.getState().rebindOfficeInstruction("chat", "i-a");
  append({ ...ref, referenceId: "ref-c", captureId: "capture-c", documentId: "doc-b" }, "i-c", "");
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")[0].instruction).toEqual({ instructionId: "i-a", text: "改为 10", bindingState: "bound", referenceIds: ["ref-c"] });
});
test("同次采集不重复添加，过期页面与跨聊天回调拒绝", () => {
  append(); append();
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")).toHaveLength(1);
  expect(() => useComposerStateStore.getState().appendOfficeSelection({ sessionId: "chat", reference: ref, instructionId: "late", text: "", epoch: 0, mode: "add" })).toThrow("已变化");
  expect(() => append({ ...ref, ownerSessionId: "other" })).toThrow("不属于");
});
test("文件切换清理必须匹配草稿代次，排队快照不随标签清理释放且能恢复", () => {
  append(); const original = draft();
  const item = useComposerStateStore.getState().appendQueuedDraft("chat", original);
  const state = useComposerStateStore.getState();
  expect(state.clearOfficeReferences("chat", 0, ["ref-a"])).toBe(false);
  expect(state.clearOfficeReferences("chat", 1, ["ref-a"])).toBe(true);
  expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", ["ref-a"])).toEqual([]);
  expect(officeSubmissionFromDraft(item.draft).officeSelectionRefs).toEqual(["ref-a"]);
  useComposerStateStore.getState().clearSession("chat");
  useComposerStateStore.getState().editQueuedDraft("chat", item.id);
  expect(officeSubmissionFromDraft(draft()).officeSelectionRefs).toEqual(["ref-a"]);
  useComposerStateStore.getState().clearSession("chat");
  expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", ["ref-a"])).toEqual(["ref-a"]);
});
test("明确改为普通文本移除执行引用；仅有标签不能提交空白修改要求", () => {
  append();
  useComposerStateStore.getState().detachOfficeInstruction("chat", "i-a");
  expect(officeSubmissionFromDraft(draft()).officeSelectionRefs).toEqual([]);
  useComposerStateStore.getState().clearSession("chat"); append(ref, "blank", "");
  expect(() => officeSubmissionFromDraft(draft())).toThrow("请输入");
});

for (const outcome of ["accepted", "blocked", "cancelled", "failed"] as const) test(`发送${outcome}期间删除标签不会提前释放引用，完成后只释放无人持有的引用`, async () => {
  append();
  const snapshot = draft();
  const submission = officeSubmissionFromDraft(snapshot);
  const finish = useComposerStateStore.getState().holdOfficeSubmission("chat", submission.officeSelectionRefs ?? []);
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  let released: string[] = [];
  const send = (async () => {
    try {
      await waiting;
      expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", [ref.referenceId])).toEqual([]);
      expect(officeSubmissionFromDraft(snapshot).officeSelectionRefs).toEqual([ref.referenceId]);
      if (outcome === "failed") throw new Error("发送失败");
      return outcome;
    } finally { released = finish(); }
  })();
  useComposerStateStore.getState().removeOfficeReference("chat", "i-a", ref.referenceId);
  expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", [ref.referenceId])).toEqual([]);
  resume();
  if (outcome === "failed") await expect(send).rejects.toThrow("发送失败");
  else expect(await send).toBe(outcome);
  expect(released).toEqual([ref.referenceId]);
  expect(finish()).toEqual([]);
  expect(useComposerStateStore.getState().officePendingSubmissions).toEqual({});
});

test("发送预检转交队列后仍持有引用；结束一个请求不会释放其他请求或原草稿的引用", () => {
  append();
  const original = draft();
  const store = useComposerStateStore.getState();
  const a = store.holdOfficeSubmission("chat", [ref.referenceId]);
  const b = store.holdOfficeSubmission("chat", [ref.referenceId]);
  expect(a()).toEqual([]);
  expect(b()).toEqual([]); // 原草稿仍持有。
  const c = store.holdOfficeSubmission("chat", [ref.referenceId]);
  store.clearSession("chat");
  const queued = store.appendQueuedDraft("chat", original);
  expect(c()).toEqual([]); // 预检完成前，引用已转交队列快照。
  store.removeQueuedDraft("chat", queued.id);
  expect(releasableOfficeReferences(useComposerStateStore.getState(), "chat", [ref.referenceId])).toEqual([ref.referenceId]);
});
