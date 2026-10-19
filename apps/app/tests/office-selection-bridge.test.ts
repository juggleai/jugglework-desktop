import { afterEach, expect, test } from "bun:test";
import { installOfficeComposerBridge } from "../src/react-app/domains/session/surface/composer/office-composer-bridge";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import type { OfficeSelectionReference } from "@jugglework/types/office";

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, officeEpochs: {} }); });
test("同文件不清理；取消、聊天切换及旧代次不能清理；成功切换保留修改要求", async () => {
  let callback: (value: any) => Promise<any> = async () => ({});
  let closed: (value: any) => void = () => {};
  globalThis.window = { __JUGGLEWORK_ELECTRON__: { office: {
    onComposerRequest: (handler: typeof callback) => { callback = handler; return () => {}; },
    onClosed: (handler: typeof closed) => { closed = handler; return () => {}; },
  } } } as unknown as Window & typeof globalThis;
  let scope = "ws:chat";
  const dispose = installOfficeComposerBridge({ navigate: () => {}, scope: () => scope });
  const ref = { referenceId: "r", captureId: "c", workspaceId: "ws", ownerSessionId: "chat", documentId: "doc", sourcePageId: "page", modelGeneration: "page:model", locator: { kind: "doc-text", ranges: [{ begin: 3, end: 5 }] }, contentStamp: "stamp", capturedAt: 1, preview: { name: "标题.docx", path: "标题.docx", range: "3–5", text: "标题" } } as OfficeSelectionReference;
  await callback({ action: "append", workspaceId: "ws", sessionId: "chat", epoch: 0, instructionId: "i", reference: ref, text: "只改这两个字", mode: "add" });
  expect((await callback({ action: "guard", workspaceId: "ws", sessionId: "chat", targetDocumentId: "doc" })).needsConfirmation).toBe(false);
  const guard = await callback({ action: "guard", workspaceId: "ws", sessionId: "chat", targetDocumentId: "other" });
  expect(guard.needsConfirmation).toBe(true);
  scope = "ws:other-chat";
  expect((await callback({ action: "clear", sessionId: "chat", ...guard })).ok).toBe(false);
  expect(useComposerStateStore.getState().sessions.chat?.officeGroups[0].instruction.bindingState).toBe("bound");
  scope = "ws:chat";
  expect((await callback({ ...guard, action: "clear", sessionId: "chat" })).ok).toBe(true);
  expect(useComposerStateStore.getState().sessions.chat?.officeGroups[0].instruction).toEqual({ instructionId: "i", text: "只改这两个字", bindingState: "needs-selection", referenceIds: [] });
  const epoch = useComposerStateStore.getState().officeEpochs.chat;
  closed({ workspaceId: "ws", sessionId: "chat", documentId: "doc" });
  expect(useComposerStateStore.getState().officeEpochs.chat).toBe(epoch + 1);
  await expect(callback({ action: "append", workspaceId: "ws", sessionId: "chat", epoch, instructionId: "late", reference: ref, text: "", mode: "add" })).rejects.toThrow("已变化");
  dispose();
});
